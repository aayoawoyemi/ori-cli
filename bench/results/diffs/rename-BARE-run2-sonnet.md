# BARE run 2 â€” PASS (ok)
# turns=6 tokens=14380 wall=16.1s

=== src/memory/warmContext.ts ===
/**
 * Warm Context Layer — the agent's working identity.
 *
 * Assembles a ~2K token block that is ALWAYS present in context:
 * - Identity (who the agent is)
 * - Goals (what's active)
 * - Last reflection (most recent synthesized insight)
 * - Top warm notes (recently active in the graph)
 *
 * This is NOT preflight. Preflight is query-driven (reactive).
 * Warm context is identity-anchored (proactive). It refreshes
 * every N turns or after reflection, not every turn.
 *
 * This block survives compaction. It IS the agent's continuity.
 */

import type { OriVault, VaultIdentity, VaultNote } from './vault.js';

// ── Config ─────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 10; // refresh every N turns
const MAX_WARM_NOTES = 3;

// ── State ──────────────────────────────────────────────────────────────────

let cachedBlock: string = '';
let turnsSinceRefresh = 0;
let initialized = false;

// ── Assembly ───────────────────────────────────────────────────────────────

/**
 * Assemble the warm context block from vault data.
 * Called at session start and periodically during the session.
 */
export async function assembleWarmContext(
  vault: OriVault | null,
  identity: VaultIdentity | null,
): Promise<string> {
  const sections: string[] = [];

  // 1. Identity — who the agent is
  if (identity?.identity) {
    // Take first ~500 chars of identity (the core, not the full file)
    const core = identity.identity.slice(0, 500).trim();
    sections.push(`Identity: ${core}`);
  }

  // 2. Goals — what's active right now
  if (identity?.goals) {
    const goals = identity.goals.slice(0, 400).trim();
    sections.push(`Active goals:\n${goals}`);
  }

  // 3. Last reflection — most recent synthesized insight
  if (vault?.connected) {
    try {
      const reflections = await vault.queryRanked('recent reflection insight synthesis', 1);
      if (reflections.length > 0) {
        sections.push(`Last reflection: "${reflections[0]!.title}"`);
      }
    } catch { /* non-fatal */ }
  }

  // 4. Top warm notes — what's been most active recently
  if (vault?.connected) {
    try {
      const context = identity?.goals ?? 'current work and active projects';
      const warm = await vault.queryWarmth(context, MAX_WARM_NOTES);
      if (warm.length > 0) {
        const lines = warm.map(n => `- "${n.title}"`).join('\n');
        sections.push(`Warm notes (recently active):\n${lines}`);
      }
    } catch { /* non-fatal */ }
  }

  if (sections.length === 0) return '';

  cachedBlock = `<warm-context>\n${sections.join('\n\n')}\n</warm-context>`;
  initialized = true;
  turnsSinceRefresh = 0;

  return cachedBlock;
}

/**
 * Get the current warm context block.
 * Returns cached version unless refresh is due.
 * Call `advanceTurn()` after each turn to track refresh timing.
 */
export function getWarmContext(): string {
  return cachedBlock;
}

/**
 * Check if warm context needs refresh (every N turns or after forced refresh).
 */
export function needsRefresh(): boolean {
  if (!initialized) return true;
  return turnsSinceRefresh >= REFRESH_INTERVAL;
}

/**
 * Increment the turn counter. Call after each model turn completes.
 */
export function advanceTurn(): void {
  turnsSinceRefresh++;
}

/**
 * Force a refresh on the next check (e.g., after reflection fires).
 */
export function forceRefresh(): void {
  turnsSinceRefresh = REFRESH_INTERVAL;
}

/**
 * Get the warm context block for compaction survival.
 * This is prepended to compacted summaries so identity is never lost.
 */
export function getWarmContextForCompaction(): string {
  return cachedBlock;
}


=== src/loop.ts ===
import type { Message, ToolCall, ToolDefinition } from './router/types.js';
import type { ModelRouter } from './router/index.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { OriVault } from './memory/vault.js';
import type { ProjectBrain } from './memory/projectBrain.js';
import type { SessionStorage } from './session/storage.js';
import type { HooksConfig } from './config/types.js';
import { executeTools, resetDoomLoop } from './tools/execution.js';
import { PhaseTracker, getToolsForPhase, type TaskPhase } from './tools/toolSets.js';
import { buildAssistantMessage, buildToolResultMessage, getMessageText } from './utils/messages.js';
import { estimateTokens } from './utils/tokens.js';
import { runPreflight, type PreflightContext } from './memory/preflight.js';
import { assembleCurrentState } from './memory/currentState.js';
import { stripSyntheticFromMessages, injectTurnSynthetics } from './memory/syntheticMarkers.js';
import { runPostflight } from './memory/postflight.js';
import { runCompaction } from './memory/compact.js';
import { advanceTurn, needsRefresh, assembleWarmContext } from './memory/warmContext.js';
import { detectEchoFizzle, sendEchoSignals } from './memory/echoFizzle.js';

// ── Loop Events (yielded to the UI) ────────────────────────────────────────

export type PermissionMode = 'default' | 'accept' | 'plan' | 'yolo';
export type PermissionDecision = 'allow' | 'deny' | 'always';

export type LoopEvent =
  | { type: 'model_start'; turn: number; model: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
  | { type: 'tool_denied'; id: string; name: string }
  | { type: 'plan_step'; toolCall: ToolCall }
  | { type: 'plan_complete'; steps: ToolCall[]; explanation: string }
  | { type: 'echo_fizzle'; echoed: string[]; fizzled: string[] }
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
  hooks?: HooksConfig;
  maxTurns?: number;
  maxResultChars?: number;
  compactThreshold?: number;
  signal?: AbortSignal;
  permissionMode?: PermissionMode;
  onPermissionRequest?: (tc: ToolCall) => Promise<PermissionDecision>;
  /** Tool names the user has said "always allow" this session. */
  alwaysAllowTools?: Set<string>;
  /** Identity context for conditioned retrieval (e.g., "Aries, building TypeScript agent harness") */
  identityContext?: string;
  /** Max concurrent subagent processes (default: 5) */
  maxSubagents?: number;
  /**
   * Whether to run preflight retrieval + inject results. When false, the loop
   * skips the 5 parallel vault queries entirely (REPL mode pulls memory on-demand).
   * Current-state injection is independent of this flag.
   */
  preflightEnabled?: boolean;
  /**
   * Called after Edit/Write tools complete with the list of mutated file paths.
   * Used for post-edit codebase graph refresh.
   */
  onFileMutated?: (paths: string[]) => Promise<void>;
  /**
   * Enable dynamic tool exposure — only expose tools relevant to the current
   * task phase (explore/edit/verify). Reduces tool schema tokens by 70-80%.
   * Default: false (expose all tools every turn, backwards-compatible).
   */
  dynamicTools?: boolean;
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
    hooks,
    maxTurns = 50,
    maxResultChars = 30_000,
    compactThreshold = 0.8,
    signal,
    permissionMode = 'default',
    onPermissionRequest,
    alwaysAllowTools,
    identityContext,
    maxSubagents = 5,
    preflightEnabled = true,
    onFileMutated,
    dynamicTools = false,
  } = params;

  const allTools: ToolDefinition[] = registry.definitions();
  const replEnabled = allTools.some(t => t.name === 'Repl');
  const phaseTracker = dynamicTools ? new PhaseTracker('lean') : null;
  const contextLimit = router.current.contextWindow;
  const compactTokenThreshold = Math.floor(contextLimit * compactThreshold);
  let turnCount = 0;
  let importanceAccumulator = 0;
  let lastPreflight: PreflightContext | null = null;

  // Reset doom loop tracking on new user input
  resetDoomLoop();

  while (turnCount < maxTurns) {
    turnCount++;

    // ── IDEMPOTENCE: strip any prior-turn synthetic injections ──────
    // Without this, each turn's preflight/current-state/proprio STACKS on
    // top of every previous turn's, linearly accumulating stale context.
    // Fix 2 + Fix 4 from orientation audit.
    stripSyntheticFromMessages(messages);

    // ── PREFLIGHT: Historical memory retrieval (gated by config) ────
    if (preflightEnabled) {
      lastPreflight = await runPreflight(messages, projectBrain, vault, identityContext);
    } else {
      lastPreflight = null;
    }

    // ── CURRENT STATE: Fresh orient() per turn ──────────────────────
    // This is the current-state lane. Runs every turn regardless of
    // preflight gating. Its purpose is to surface CURRENT truth
    // (today's goals/pending/identity) so the model stops reasoning
    // from historical graph state when the user asks about NOW.
    const currentStateBlock = await assembleCurrentState(vault);

    // ── CONTEXT PROPRIOCEPTION ─────────────────────────────────────
    const tokenEst = estimateTokens(messages);
    const utilizationPct = Math.round((tokenEst / contextLimit) * 100);
    const preflightTitles = lastPreflight
      ? [...lastPreflight.projectNotes, ...lastPreflight.vaultNotes].map(n => {
          const tag = n.contradicting ? ' [CONTRADICTS]' : '';
          return `"${n.title}"${tag}`;
        })
      : [];

    const proprioceptionBlock = [
      `<context-status>`,
      `Context: ${utilizationPct}% (${tokenEst}/${contextLimit} tokens estimated)`,
      preflightTitles.length > 0
        ? `Memories loaded this turn: ${preflightTitles.join(', ')}`
        : 'No memories retrieved this turn.',
      `</context-status>`,
    ].join('\n');

    // ── INJECTION: wrap all synthetic blocks with stable markers ────
    // Positional precedence (top→bottom as seen by model):
    //   1. preflight-before (historical — farthest)
    //   2. current-state    (fresh truth — closest to user text)
    //   3. [user message]
    //   4. preflight-after  (contradictions)
    //   5. proprio          (closest to generation)
    injectTurnSynthetics(messages, {
      preflightBefore: lastPreflight?.beforeUserBlock || undefined,
      currentState: currentStateBlock || undefined,
      preflightAfter: lastPreflight?.afterUserBlock || undefined,
      proprio: proprioceptionBlock,
    });

    if (lastPreflight) {
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

    // ── TOOL FILTERING (structural enforcement) ────────────────────
    // Plan mode: REMOVE write tools so the model can't even consider them.
    // Dynamic tools: only expose tools for the current task phase.
    let activeTools: ToolDefinition[];
    if (permissionMode === 'plan') {
      activeTools = allTools.filter(t => registry.isReadOnly(t.name));
    } else if (phaseTracker) {
      activeTools = getToolsForPhase(registry, phaseTracker.phase, replEnabled);
    } else {
      activeTools = allTools;
    }

    // ── MODEL CALL ───────────────────────────────────────────────────
    yield { type: 'model_start', turn: turnCount, model: router.info.model };

    let assistantText = '';
    const toolCalls: ToolCall[] = [];
    const pendingToolInputs = new Map<string, { name: string; json: string }>();

    try {
      for await (const event of router.stream(budgetedMessages, systemPrompt, activeTools, signal)) {
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

    // ── TOOL EXECUTION (with permission gates) ────────────────────────
    if (toolCalls.length > 0) {
      messages.push(buildAssistantMessage(assistantText, toolCalls));

      session?.log({ type: 'assistant', content: assistantText, timestamp: Date.now() });
      for (const tc of toolCalls) {
        session?.log({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input, timestamp: Date.now() });
      }

      // ── PERMISSION CHECK per tool call ───────────────────────────
      const approvedCalls: ToolCall[] = [];
      const deniedResults: { id: string; name: string; output: string; isError: boolean }[] = [];

      for (const tc of toolCalls) {
        const isRead = registry.isReadOnly(tc.name);

        if (isRead || permissionMode === 'yolo') {
          approvedCalls.push(tc);
          continue;
        }
        if (permissionMode === 'accept' && tc.name !== 'Bash') {
          approvedCalls.push(tc);
          continue;
        }
        if (alwaysAllowTools?.has(tc.name)) {
          approvedCalls.push(tc);
          continue;
        }
        if (onPermissionRequest) {
          const decision = await onPermissionRequest(tc);
          if (decision === 'allow') {
            approvedCalls.push(tc);
          } else if (decision === 'always') {
            alwaysAllowTools?.add(tc.name);
            approvedCalls.push(tc);
          } else {
            yield { type: 'tool_denied', id: tc.id, name: tc.name };
            deniedResults.push({ id: tc.id, name: tc.name, output: 'Tool use denied by user.', isError: true });
          }
        } else {
          approvedCalls.push(tc);
        }
      }

      // Execute approved tools
      let executedResults: { id: string; name: string; output: string; isError: boolean }[] = [];
      if (approvedCalls.length > 0) {
        const results = await executeTools(approvedCalls, registry, toolContext, hooks, vault?.vaultPath, maxSubagents);
        executedResults = results;

        // Post-edit refresh
        const mutatedPaths: string[] = [];
        for (const tc of approvedCalls) {
          if ((tc.name === 'Edit' || tc.name === 'Write') && tc.input?.file_path) {
            mutatedPaths.push(tc.input.file_path as string);
          }
        }
        if (mutatedPaths.length > 0 && onFileMutated) {
          onFileMutated(mutatedPaths).catch(() => {});
        }
      }

      // Combine ALL results into ONE user message (Anthropic requires all
      // tool_results for one assistant turn in a single message).
      const allResults = [...deniedResults, ...executedResults];
      if (allResults.length > 0) {
        const combinedContent = allResults.map(r => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.output,
          is_error: r.isError,
        }));
        messages.push({ role: 'user', content: combinedContent });

        for (const result of allResults) {
          yield {
            type: 'tool_result',
            id: result.id,
            name: result.name,
            output: result.output.slice(0, 500),
            isError: result.isError,
          };
          session?.log({
            type: 'tool_result',
            id: result.id, name: result.name,
            output: result.output.slice(0, 5000),
            isError: result.isError,
            timestamp: Date.now(),
          });
          // Phase tracker: transition on tool calls
          if (phaseTracker) {
            phaseTracker.onToolCall(result.name, replEnabled);
          }
        }
      }

      continue;
    }

    // ── TURN COMPLETE (text-only response) ───────────────────────────
    messages.push({ role: 'assistant', content: assistantText });
    session?.log({ type: 'assistant', content: assistantText, timestamp: Date.now() });

    // ── ECHO/FIZZLE: which preflight notes did the model actually use? ──
    if (lastPreflight && assistantText.length > 50) {
      const ef = detectEchoFizzle(assistantText, lastPreflight);
      if (ef.echoed.length > 0 || ef.fizzled.length > 0) {
        yield { type: 'echo_fizzle', echoed: ef.echoed, fizzled: ef.fizzled };
        // Send echo signals to Ori (fire-and-forget)
        sendEchoSignals(ef, vault).catch(() => {});
      }
    }

    // ── POSTFLIGHT ───────────────────────────────────────────────────
    importanceAccumulator = await runPostflight(
      messages, lastPreflight, projectBrain, vault, importanceAccumulator, router,
    );

    // ── WARM CONTEXT TICK ────────────────────────────────────────────
    // Track turns for periodic warm context refresh.
    // When refresh is due, re-query vault for latest reflection + warm notes.
    advanceTurn();
    if (needsRefresh() && vault?.connected) {
      assembleWarmContext(vault, null).catch(() => {});
    }

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


