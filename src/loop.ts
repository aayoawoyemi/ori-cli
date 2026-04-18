import { resolve } from 'node:path';
import type { Message, ToolCall, ToolDefinition, ContentBlock } from './router/types.js';
import type { ModelRouter } from './router/index.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { OriVault } from './memory/vault.js';
import type { ProjectBrain } from './memory/projectBrain.js';
import type { SessionStorage } from './session/storage.js';
import type { HooksConfig } from './config/types.js';
import { executeTools, resetDoomLoop } from './tools/execution.js';
import { PhaseTracker, getToolsForPhase, type TaskPhase } from './tools/toolSets.js';
import { buildAssistantMessage, buildToolResultMessage, getMessageText, healOrphanedToolUses } from './utils/messages.js';
import { estimateTokens } from './utils/tokens.js';
import { runPreflight, type PreflightContext } from './memory/preflight.js';
// current-state injection removed — model calls ori_orient directly
import { stripSyntheticFromMessages, injectTurnSynthetics } from './memory/syntheticMarkers.js';
import { runPostflight } from './memory/postflight.js';
import { runCompaction } from './memory/compact.js';
import { tickTurn, needsRefresh, assembleWarmContext } from './memory/warmContext.js';
import { detectEchoFizzle, sendEchoSignals } from './memory/echoFizzle.js';
import { applyNudges, resetNudgeCounters } from './tools/nudge.js';
import { getPlanModeSparseReminder } from './tools/planInstructions.js';

// ── Loop Events (yielded to the UI) ────────────────────────────────────────

export type PermissionMode = 'default' | 'accept' | 'plan' | 'research' | 'yolo';
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
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
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
  /** Ref to the plan file path (set when EnterPlanMode runs). Using a ref so loop reads live value. */
  planFilePathRef?: { current: string | null };
  /** Ref to permission mode — live-read each turn so ExitPlanMode approval takes effect immediately. */
  permissionModeRef?: { current: PermissionMode };
  /** Task mode: 'explore' restricts to Repl + VaultAdd + ProjectSave only. */
  taskMode?: 'normal' | 'explore';
}

// ── Result Budget ───────────────────────────────────────────────────────────
// Cap large outputs at maxChars using head + tail (like Claude Code's 5K+5K).
// This prevents tool results from accumulating unbounded in conversation history.

function applyResultBudget(messages: Message[], maxChars: number): Message[] {
  const half = Math.floor(maxChars / 2);

  function capString(s: string): string {
    if (s.length <= maxChars) return s;
    const omitted = s.length - maxChars;
    return `${s.slice(0, half)}\n\n... [${omitted} chars omitted] ...\n\n${s.slice(-half)}`;
  }

  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg.content.length > maxChars ? { ...msg, content: capString(msg.content) } : msg;
    }
    const blocks = msg.content as ContentBlock[];
    const newBlocks = blocks.map(block => {
      if (block.type === 'tool_result' && block.content.length > maxChars) {
        return { ...block, content: capString(block.content) };
      }
      return block;
    });
    const changed = newBlocks.some((b, i) => b !== blocks[i]);
    return changed ? { ...msg, content: newBlocks } : msg;
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
    maxResultChars = 10_000,
    compactThreshold = 0.6,
    signal,
    onPermissionRequest,
    alwaysAllowTools,
    identityContext,
    maxSubagents = 5,
    preflightEnabled = true,
    onFileMutated,
    dynamicTools = false,
    planFilePathRef,
    permissionModeRef,
    taskMode = 'normal',
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

    // Live-read permissionMode from ref each turn so ExitPlanMode approval
    // takes effect immediately (not stale from agentLoop call-site).
    const permissionMode: PermissionMode = permissionModeRef?.current ?? params.permissionMode ?? 'default';

    // ── IDEMPOTENCE: strip any prior-turn synthetic injections ──────
    // Without this, each turn's preflight/current-state/proprio STACKS on
    // top of every previous turn's, linearly accumulating stale context.
    // Fix 2 + Fix 4 from orientation audit.
    stripSyntheticFromMessages(messages);

    // ── HEAL orphaned tool_use blocks ────────────────────────────────
    // If a prior turn was interrupted (Ctrl+C mid-tool, executeTools threw,
    // permission flow abandoned), an assistant message with tool_use blocks
    // may be sitting in history without matching tool_result entries. The
    // Anthropic API rejects this with a 400. Inject synthetic error results
    // so the conversation stays valid.
    healOrphanedToolUses(messages);

    // Reset per-turn nudge counters (sequential read tracking, etc.)
    resetNudgeCounters();

    // ── PREFLIGHT: Re-enabled 2026-04-17. 5-note limit, ~150 tokens/turn.
    // Agent cannot retrieve what it doesn't know to look for —
    // preflight bridges user intent to vault knowledge.
    if (preflightEnabled && vault?.connected) {
      lastPreflight = await runPreflight(messages, projectBrain, vault, identityContext);
      if (lastPreflight) {
        session?.log({ type: 'preflight', projectNotes: lastPreflight.projectNotes.map(n => n.title), vaultNotes: lastPreflight.vaultNotes.map(n => n.title), timestamp: Date.now() });
        yield { type: 'preflight', projectCount: lastPreflight.projectNotes.length, vaultCount: lastPreflight.vaultNotes.length };
      }
    }

    // ── CONTEXT PROPRIOCEPTION ─────────────────────────────────────
    const tokenEst = estimateTokens(messages);
    const utilizationPct = Math.round((tokenEst / contextLimit) * 100);

    const proprioceptionBlock = [
      `<context-status>`,
      `Context: ${utilizationPct}% (${tokenEst}/${contextLimit} tokens estimated)`,
      `</context-status>`,
    ].join('\n');

    // ── INJECTION: preflight + proprioception ─────────────────────
    injectTurnSynthetics(messages, {
      preflightBefore: lastPreflight?.beforeUserBlock,
      preflightAfter: lastPreflight?.afterUserBlock,
      proprio: proprioceptionBlock,
    });

    // Auto-compaction disabled — never compact mid-task.

    // ── RESULT BUDGET ────────────────────────────────────────────────
    const budgetedMessages = applyResultBudget(messages, maxResultChars);

    // ── TOOL FILTERING (structural enforcement) ────────────────────
    // Explore mode (highest priority): Repl + VaultAdd + ProjectSave only.
    // Plan mode: read-only tools + Write/Edit (clamped to plan file at execution).
    // Research mode: read-only tools only.
    // Dynamic tools: only expose tools for the current task phase.
    let activeTools: ToolDefinition[];
    if (taskMode === 'explore') {
      activeTools = allTools.filter(t =>
        t.name === 'Repl' || t.name === 'VaultAdd' || t.name === 'ProjectSave'
      );
    } else if (permissionMode === 'plan') {
      activeTools = allTools.filter(t => {
        if (registry.isReadOnly(t.name)) return true;
        // Write/Edit included in schema — enforced to plan file at execution time
        if (t.name === 'Write' || t.name === 'Edit') return true;
        // ExitPlanMode is readOnly=false (triggers approval) — include explicitly
        if (t.name === 'ExitPlanMode') return true;
        return false;
      });
    } else if (permissionMode === 'research') {
      // Research mode: structural tool stripping — explicit allowlist.
      // WebSearch/WebFetch are REMOVED (even though they're readOnly) because they
      // let the model bypass the curated research pipeline. For targeted URL
      // drill-down, the model uses `research.fetch(url)` in the Repl namespace.
      const RESEARCH_ALLOWED = new Set([
        'Repl', 'Read', 'Grep', 'Glob', 'ProjectSave',
        'VaultSearch', 'VaultRead', 'VaultExplore', 'VaultWarmth', 'ProjectSearch',
      ]);
      activeTools = allTools.filter(t => RESEARCH_ALLOWED.has(t.name));
    } else if (phaseTracker) {
      activeTools = getToolsForPhase(registry, phaseTracker.phase, replEnabled);
    } else {
      activeTools = allTools;
    }

    // ── Research mode reminder ────────────────────────────────────────
    if (permissionMode === 'research') {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        if (!content.includes('RESEARCH mode')) {
          budgetedMessages[lastUserIdx] = {
            ...budgetedMessages[lastUserIdx]!,
            content: `<system-reminder>You are in RESEARCH mode. WebSearch, WebFetch, Write, Edit, Bash, and Agent are NOT available — they have been structurally removed from your tool schema. Research happens through the \`research\` namespace in the Repl tool:\n\n- \`research.discover(query, limit=25)\` → multi-API search (arxiv, semantic scholar, openalex, github, exa, reddit, wikipedia)\n- \`research.ingest(sources[:8])\` → deep-fetch content, returns handles\n- \`research.fetch(url, focus="...")\` → targeted drill-down on a specific URL (replaces WebFetch)\n- \`research.extract(handle, focus="...")\` → pull findings from one source\n- \`research.synthesize(findings, query)\` → cross-source analysis\n- \`research.save(session)\` → persist with a slug (REQUIRED to exit research mode)\n- \`research.list_sessions()\` / \`research.session(slug)\` → prior sessions\n\nThe pipeline is curated and recursive: discover → ingest → extract → reflect → synthesize. Let it run. Steer with focus questions. Pick 5-10 promising sources, not all 25. Show your work — the user can interject. You MUST call \`research.save()\` before ending the turn; that produces the durable artifact and exits research mode.</system-reminder>\n\n${content}`,
          };
        }
      }
    }

    // ── Explore mode reminder ─────────────────────────────────────────
    if (taskMode === 'explore') {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        if (!content.includes('EXPLORE mode')) {
          budgetedMessages[lastUserIdx] = {
            ...budgetedMessages[lastUserIdx]!,
            content: `<system-reminder>You are in EXPLORE mode. You can only use Repl, VaultAdd, and ProjectSave. No file modifications, no shell commands. If the user asks you to make changes, tell them to switch to Normal mode (Alt+Z).</system-reminder>\n\n${content}`,
          };
        }
      }
    }

    // ── Plan mode sparse reminder (survives compaction) ──────────────
    const planFilePath = planFilePathRef?.current ?? null;

    // ── Plan mode Gate 1: force EnterPlanMode if no plan file yet ────
    if (permissionMode === 'plan' && !planFilePath) {
      const enterTool = allTools.find(t => t.name === 'EnterPlanMode');
      if (enterTool) activeTools = [enterTool];
    }

    if (permissionMode === 'plan' && planFilePath) {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        if (!content.includes('Plan mode')) {
          budgetedMessages[lastUserIdx] = {
            ...budgetedMessages[lastUserIdx]!,
            content: `<system-reminder>${getPlanModeSparseReminder(planFilePath)}</system-reminder>\n\n${content}`,
          };
        }
      }
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
            yield { type: 'usage', inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens, cacheReadTokens: event.cacheReadTokens, cacheWriteTokens: event.cacheWriteTokens };
            break;

          case 'done':
            break;
        }
      }
    } catch (err) {
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
        // Plan mode: clamp Write/Edit to plan file only, auto-approve everything else
        if (permissionMode === 'plan') {
          if (tc.name === 'Write' || tc.name === 'Edit') {
            const targetPath = resolve(toolContext.cwd, tc.input.file_path as string);
            const planPath = planFilePath ? resolve(planFilePath) : null;
            if (planPath && targetPath === planPath) {
              approvedCalls.push(tc); // auto-approve — it's the plan file
            } else {
              deniedResults.push({
                id: tc.id, name: tc.name,
                output: `In plan mode, only the plan file is writable: ${planPath ?? '(call EnterPlanMode first)'}`,
                isError: true,
              });
            }
          } else {
            // Everything else in plan mode (reads, ExitPlanMode) auto-approved
            approvedCalls.push(tc);
          }
          continue;
        }

        // Research mode: deny any tool not in the research allowlist.
        // Belt-and-suspenders — schema filtering should already block these,
        // but this catches edge cases (subagents, tool schema leaks).
        if (permissionMode === 'research') {
          const RESEARCH_ALLOWED = new Set([
            'Repl', 'Read', 'Grep', 'Glob', 'ProjectSave',
            'VaultSearch', 'VaultRead', 'VaultExplore', 'VaultWarmth', 'ProjectSearch',
          ]);
          if (RESEARCH_ALLOWED.has(tc.name)) {
            approvedCalls.push(tc);
          } else {
            deniedResults.push({
              id: tc.id, name: tc.name,
              output: `Tool ${tc.name} is not available in research mode. Use the research.* namespace in the Repl instead (research.discover, research.ingest, research.extract, research.synthesize, research.fetch, research.save). Alt+M to exit research mode.`,
              isError: true,
            });
          }
          continue;
        }

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
        try {
          executedResults = await executeTools(approvedCalls, registry, toolContext, hooks, vault?.vaultPath, maxSubagents);
        } catch (err) {
          // Never leave orphaned tool_use in history. Synthesize an error
          // result for every approved call so the conversation stays valid.
          const msg = (err as Error)?.message ?? String(err);
          executedResults = approvedCalls.map(tc => ({
            id: tc.id,
            name: tc.name,
            output: `Tool execution failed: ${msg}`,
            isError: true,
          }));
          yield { type: 'error', error: err };
        }

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

      // Apply contextual REPL nudges to tool results
      applyNudges(executedResults, replEnabled);

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

    // ── Research mode Gate 2: force continuation if research started but not saved ──
    if (permissionMode === 'research') {
      // Detect "research in progress" by scanning prior Repl tool calls for research.* usage.
      let researchStarted = false;
      let researchSaved = false;
      for (const m of messages) {
        if (m.role !== 'assistant' || typeof m.content === 'string' || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if ((block as { type?: string }).type !== 'tool_use') continue;
          const tu = block as { name?: string; input?: { code?: string } };
          if (tu.name !== 'Repl' || !tu.input?.code) continue;
          const code = tu.input.code;
          if (/\bresearch\.(discover|ingest|extract|synthesize|fetch|reflect)\b/.test(code)) {
            researchStarted = true;
          }
          if (/\bresearch\.save\b/.test(code)) {
            researchSaved = true;
          }
        }
      }
      if (researchStarted && !researchSaved) {
        const forcedKey = '__researchForcedContinuations';
        const forced = ((params as unknown as Record<string, unknown>)[forcedKey] as number) ?? 0;
        if (forced < 2) {
          (params as unknown as Record<string, unknown>)[forcedKey] = forced + 1;
          messages.push({ role: 'assistant', content: assistantText });
          messages.push({
            role: 'user',
            content: `<system-reminder>You started research but haven't saved it yet. Call \`research.save(session)\` in the Repl to persist the artifact and exit research mode, or continue with research.discover/ingest/extract/synthesize if you're not done. Do not end the turn with text only — research mode requires an artifact.</system-reminder>`,
          });
          turnCount++;
          continue;
        }
      }
    }

    // ── Plan mode Gate 2: force continuation if model dumps text without ExitPlanMode ──
    if (permissionMode === 'plan' && planFilePath) {
      // Model responded with text only — it must call ExitPlanMode or AskUserQuestion to end.
      // Inject a system nudge and continue the loop (max 2 forced continuations).
      const forcedKey = '__planForcedContinuations';
      const forced = ((params as unknown as Record<string, unknown>)[forcedKey] as number) ?? 0;
      if (forced < 2) {
        (params as unknown as Record<string, unknown>)[forcedKey] = forced + 1;
        messages.push({ role: 'assistant', content: assistantText });
        messages.push({
          role: 'user',
          content: `<system-reminder>You're still in plan mode. Write your plan to the plan file and call ExitPlanMode, or ask the user a question with AskUserQuestion. Do not end turns with text only.</system-reminder>`,
        });
        turnCount++;
        continue;
      }
    }

    // ── TURN COMPLETE (text-only response) ───────────────────────────
    messages.push({ role: 'assistant', content: assistantText });
    session?.log({ type: 'assistant', content: assistantText, timestamp: Date.now() });

    // ── ECHO/FIZZLE: re-enabled with preflight (2026-04-17) ────────
    if (lastPreflight) {
      const ef = detectEchoFizzle(assistantText, lastPreflight);
      if (ef.echoed.length > 0 || ef.fizzled.length > 0) {
        yield { type: 'echo_fizzle', echoed: ef.echoed, fizzled: ef.fizzled };
        await sendEchoSignals(ef, vault);
      }
    }

    // ── POSTFLIGHT ───────────────────────────────────────────────────
    importanceAccumulator = await runPostflight(
      messages, null, projectBrain, vault, importanceAccumulator, router,
    );

    // ── WARM CONTEXT TICK ────────────────────────────────────────────
    // Track turns for periodic warm context refresh.
    // When refresh is due, re-query vault for latest reflection + warm notes.
    tickTurn();
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
