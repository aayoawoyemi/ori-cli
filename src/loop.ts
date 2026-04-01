import type { Message, ToolCall, ToolDefinition } from './router/types.js';
import type { ModelRouter } from './router/index.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { OriVault } from './memory/vault.js';
import type { ProjectBrain } from './memory/projectBrain.js';
import type { SessionStorage } from './session/storage.js';
import { executeTools, resetDoomLoop } from './tools/execution.js';
import { buildAssistantMessage, buildToolResultMessage, getMessageText } from './utils/messages.js';
import { estimateTokens } from './utils/tokens.js';
import { runPreflight, injectPreflightContext, type PreflightContext } from './memory/preflight.js';
import { runPostflight } from './memory/postflight.js';
import { runCompaction } from './memory/compact.js';

// ── Loop Events (yielded to the UI) ────────────────────────────────────────

export type LoopEvent =
  | { type: 'model_start'; turn: number; model: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { type: 'preflight'; projectCount: number; vaultCount: number }
  | { type: 'compact'; summary: string; savedCount: number; pruneOnly: boolean }
  | { type: 'turn_complete'; turn: number; tokenEstimate: number }
  | { type: 'error'; error: unknown };

// ── Loop Parameters ─────────────────────────────────────────────────────────

export interface LoopParams {
  messages: Message[];
  systemPrompt: string;
  router: ModelRouter;
  registry: ToolRegistry;
  toolContext: ToolContext;
  vault: OriVault | null;
  projectBrain: ProjectBrain | null;
  session: SessionStorage | null;
  maxTurns?: number;
  maxResultChars?: number;
  compactThreshold?: number;  // fraction (0.0-1.0), default 0.8
  signal?: AbortSignal;
}

// ── Result Budget ───────────────────────────────────────────────────────────

function applyResultBudget(messages: Message[], maxChars: number): Message[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string' && msg.content.length > maxChars) {
      const preview = msg.content.slice(0, 2000);
      const truncated = `${preview}\n\n... (${msg.content.length} chars total, truncated to ${maxChars})`;
      return { ...msg, content: truncated };
    }
    return msg;
  });
}

// ── The Agent Loop ──────────────────────────────────────────────────────────

export async function* agentLoop(params: LoopParams): AsyncGenerator<LoopEvent> {
  const {
    messages,
    systemPrompt,
    router,
    registry,
    toolContext,
    vault,
    projectBrain,
    session,
    maxTurns = 50,
    maxResultChars = 30_000,
    compactThreshold = 0.8,
    signal,
  } = params;

  const tools: ToolDefinition[] = registry.definitions();
  const contextLimit = router.current.contextWindow;
  const compactTokenThreshold = Math.floor(contextLimit * compactThreshold);
  let turnCount = 0;
  let importanceAccumulator = 0;
  let lastPreflight: PreflightContext | null = null;

  // Reset doom loop tracking on new user input
  resetDoomLoop();

  while (turnCount < maxTurns) {
    turnCount++;

    // ── PREFLIGHT: Memory retrieval ──────────────────────────────────
    lastPreflight = await runPreflight(messages, projectBrain, vault);
    if (lastPreflight) {
      injectPreflightContext(messages, lastPreflight);
      yield {
        type: 'preflight',
        projectCount: lastPreflight.projectNotes.length,
        vaultCount: lastPreflight.vaultNotes.length,
      };

      session?.log({
        type: 'preflight',
        projectNotes: lastPreflight.projectNotes.map(n => n.title),
        vaultNotes: lastPreflight.vaultNotes.map(n => n.title),
        timestamp: Date.now(),
      });
    }

    // ── COMPACTION CHECK ─────────────────────────────────────────────
    const tokenEst = estimateTokens(messages);
    if (tokenEst > compactTokenThreshold) {
      const result = await runCompaction(
        messages, projectBrain, vault, router, compactTokenThreshold,
      );

      // Replace messages in-place
      messages.length = 0;
      messages.push(...result.messages);

      yield {
        type: 'compact',
        summary: result.summary.slice(0, 200),
        savedCount: result.saved.length,
        pruneOnly: result.pruneOnly,
      };

      session?.log({
        type: 'compact_boundary',
        summary: result.summary,
        insightsSaved: result.saved.length,
        pruneOnly: result.pruneOnly,
        timestamp: Date.now(),
      });
    }

    // ── RESULT BUDGET ────────────────────────────────────────────────
    const budgetedMessages = applyResultBudget(messages, maxResultChars);

    // ── MODEL CALL ───────────────────────────────────────────────────
    yield { type: 'model_start', turn: turnCount, model: router.info.model };

    let assistantText = '';
    const toolCalls: ToolCall[] = [];
    const pendingToolInputs = new Map<string, { name: string; json: string }>();

    try {
      for await (const event of router.stream(budgetedMessages, systemPrompt, tools, signal)) {
        switch (event.type) {
          case 'text':
            assistantText += event.content;
            yield { type: 'text', content: event.content };
            break;

          case 'tool_use_start':
            pendingToolInputs.set(event.id, { name: event.name, json: '' });
            break;

          case 'tool_use_delta': {
            const buf = pendingToolInputs.get(event.id);
            if (buf) buf.json += event.delta;
            break;
          }

          case 'tool_use_end': {
            const pending = pendingToolInputs.get(event.id);
            const toolName = pending?.name ?? 'unknown';
            toolCalls.push({ id: event.id, name: toolName, input: event.input });
            pendingToolInputs.delete(event.id);
            yield { type: 'tool_call', toolCall: { id: event.id, name: toolName, input: event.input } };
            break;
          }

          case 'usage':
            yield { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
            break;

          case 'done':
            break;
        }
      }
    } catch (err) {
      // Prompt too long — emergency compaction
      if (err instanceof Error && (err.message.includes('too long') || err.message.includes('context_length'))) {
        const result = await runCompaction(
          messages, projectBrain, vault, router, compactTokenThreshold,
        );
        messages.length = 0;
        messages.push(...result.messages);
        yield { type: 'compact', summary: 'Emergency compaction triggered', savedCount: result.saved.length, pruneOnly: result.pruneOnly };
        continue;
      }
      yield { type: 'error', error: err };
      return;
    }

    // ── TOOL EXECUTION ───────────────────────────────────────────────
    if (toolCalls.length > 0) {
      messages.push(buildAssistantMessage(assistantText, toolCalls));

      session?.log({ type: 'assistant', content: assistantText, timestamp: Date.now() });
      for (const tc of toolCalls) {
        session?.log({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input, timestamp: Date.now() });
      }

      const results = await executeTools(toolCalls, registry, toolContext);

      for (const result of results) {
        yield {
          type: 'tool_result',
          id: result.id,
          name: result.name,
          output: result.output.slice(0, 500),
          isError: result.isError,
        };
        messages.push(buildToolResultMessage(result.id, result.output, result.isError));
        session?.log({
          type: 'tool_result',
          id: result.id, name: result.name,
          output: result.output.slice(0, 5000),
          isError: result.isError,
          timestamp: Date.now(),
        });
      }

      continue;
    }

    // ── TURN COMPLETE ────────────────────────────────────────────────
    messages.push({ role: 'assistant', content: assistantText });
    session?.log({ type: 'assistant', content: assistantText, timestamp: Date.now() });

    // ── POSTFLIGHT ───────────────────────────────────────────────────
    importanceAccumulator = await runPostflight(
      messages, lastPreflight, projectBrain, vault, importanceAccumulator,
    );

    session?.log({
      type: 'postflight',
      importance: importanceAccumulator,
      reflected: false,
      timestamp: Date.now(),
    });

    const finalTokens = estimateTokens(messages);
    yield { type: 'turn_complete', turn: turnCount, tokenEstimate: finalTokens };

    return;
  }

  yield { type: 'error', error: new Error(`Max turns exceeded (${maxTurns})`) };
}
