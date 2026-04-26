import { resolve } from 'node:path';
import type { Message, ToolCall, ToolDefinition, ContentBlock } from './router/types.js';
import type { ModelRouter } from './router/index.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext, TurnStats } from './tools/types.js';
import type { OriVault } from './memory/vault.js';
import type { ProjectBrain } from './memory/projectBrain.js';
import type { SessionStorage } from './session/storage.js';
import type { HooksConfig } from './config/types.js';
import { executeTools, resetDoomLoop } from './tools/execution.js';
// Phase tracker dropped 2026-04-19. Its widen-path was dead code (model cannot
// call a tool it cannot see, so the lean phase was a one-way trap). Full tool
// set exposed every turn now. Following Claude Code's pattern.
// toolSets.ts kept intact as dead code — delete in a later sweep.
import { buildAssistantMessage, buildToolResultMessage, getMessageText, healOrphanedToolUses } from './utils/messages.js';
import { estimateTokens } from './utils/tokens.js';
// Per-turn preflight injection killed 2026-04-19 (no-injection architecture).
// Model pulls memory on-demand via vault.* in the Repl. Preflight functions
// live on in src/memory/preflight.ts for repurpose as session-start soft-map.
import { stripSyntheticFromMessages, wrapSynthetic } from './memory/syntheticMarkers.js';
import { runPostflight } from './memory/postflight.js';
import { runCompaction, pruneToolOutputs } from './memory/compact.js';
// tickTurn / assembleWarmContext per-turn refresh removed alongside preflight kill.
// Warm context still assembled at session start; no per-turn vault round-trip.
// Echo/fizzle vault writes removed entirely (no auto-writes to main vault).
import { applyNudges, resetNudgeCounters } from './tools/nudge.js';
import { getPlanModeSparseReminder } from './tools/planInstructions.js';

// ── Loop Events (yielded to the UI) ────────────────────────────────────────

export type PermissionMode = 'default' | 'accept' | 'plan' | 'research' | 'yolo';
export type PermissionDecision = 'allow' | 'deny' | 'always';

export type LoopEvent =
  | { type: 'model_start'; turn: number; model: string }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  // `output` is truncated for UI streaming (500 chars); `output_full` carries
  // the complete tool output for consumers that need the whole thing —
  // primarily the subagent branch in src/index.ts, which folds Repl outputs
  // (containing say() narration + stdout) into the child process stdout so
  // the parent Agent tool sees the subagent's actual work. Before Batch 1.8,
  // the subagent only captured assistant-text events; a subagent that did
  // all its work via Repl + done(value) emitted zero text and the parent
  // saw "(no output)." Keeping both fields avoids churning every existing
  // UI consumer while giving capture-oriented consumers the full picture.
  | { type: 'tool_result'; id: string; name: string; output: string; output_full?: string; isError: boolean }
  | { type: 'tool_denied'; id: string; name: string }
  | { type: 'plan_step'; toolCall: ToolCall }
  | { type: 'plan_complete'; steps: ToolCall[]; explanation: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'compact'; summary: string; savedCount: number; pruneOnly: boolean }
  | { type: 'turn_complete'; turn: number; tokenEstimate: number }
  // Batch 3 — surfaced when the provider observed stop_reason=max_tokens
  // (or context_window). The handler in the stream consumer below appends
  // a [harness:cutoff] marker to the assistant message so the next turn's
  // context shows the model "you got cut off, continue from where you
  // left off." Pattern lifted from Claude Code's services/api/claude.ts:
  // they inject the cue INTO the current stream as an assistant API
  // error message rather than queuing a next-turn reminder, because the
  // model handles continuation more naturally when the cue lives in its
  // own most-recent output.
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string }
  // Batch 3 addendum — surfaced when the recovery loop auto-continues after
  // a max_tokens cutoff. Mirrors Claude Code's max_output_tokens_recovery
  // transition in query.ts. The UI can show a brief "continuing..." indicator.
  | { type: 'max_output_recovery'; attempt: number; maxAttempts: number }
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
   * Called after Edit/Write tools complete with the list of mutated file paths.
   * Used for post-edit codebase graph refresh.
   */
  onFileMutated?: (paths: string[]) => Promise<void>;
  /**
   * DEPRECATED 2026-04-19: phase tracker removed (dead code — widen path never
   * fired because the model cannot call a tool it cannot see in its schema).
   * Flag kept for backwards compatibility with existing callers; ignored at
   * runtime. Full tool set is exposed every turn.
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

const PER_MESSAGE_AGGREGATE_CHARS = 25_000; // ~6250 tokens — cap for all tool_results in one message combined

function applyResultBudget(messages: Message[], maxChars: number): Message[] {
  const half = Math.floor(maxChars / 2);

  function capString(s: string, cap: number): string {
    if (s.length <= cap) return s;
    const h = Math.floor(cap / 2);
    const omitted = s.length - cap;
    return `${s.slice(0, h)}\n\n... [${omitted} chars omitted] ...\n\n${s.slice(-h)}`;
  }

  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return msg.content.length > maxChars ? { ...msg, content: capString(msg.content, maxChars) } : msg;
    }
    const blocks = msg.content as ContentBlock[];

    // Per-message aggregate cap on tool_results. Five parallel greps each
    // returning 10k chars would otherwise drop 50k chars of exhaust into one
    // turn. When aggregate exceeds the cap, compute a per-block budget by
    // proportional shrinkage (with a floor so tiny results aren't harmed).
    const toolResults = blocks.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    const totalToolChars = toolResults.reduce((sum, b) => sum + b.content.length, 0);

    let perBlockBudget = maxChars;
    if (totalToolChars > PER_MESSAGE_AGGREGATE_CHARS && toolResults.length > 1) {
      const ratio = PER_MESSAGE_AGGREGATE_CHARS / totalToolChars;
      perBlockBudget = Math.max(2000, Math.floor(maxChars * ratio));
    }

    const newBlocks = blocks.map(block => {
      if (block.type === 'tool_result' && block.content.length > perBlockBudget) {
        return { ...block, content: capString(block.content, perBlockBudget) };
      }
      return block;
    });
    const changed = newBlocks.some((b, i) => b !== blocks[i]);
    // quieten unused-var for the preserved half constant from before the rewrite
    void half;
    return changed ? { ...msg, content: newBlocks } : msg;
  });
}

// ── The Agent Loop ──────────────────────────────────────────────────────────

type ToolExecutionResult = {
  id: string;
  name: string;
  output: string;
  isError: boolean;
};

type ToolRejectionState = {
  count: number;
  lastOutput: string;
  tsOrJsInPythonRepl: boolean;
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyToolRejection(result: ToolExecutionResult): { tsOrJsInPythonRepl: boolean } | null {
  if (!result.isError) return null;

  const output = result.output.trim();
  const toolPrefix = new RegExp(`^${escapeRegExp(result.name)} rejected:`, 'i');
  const isRejected =
    /^Repl rejected:/i.test(output) ||
    /^Vault rejected:/i.test(output) ||
    /^AST guard rejected:/i.test(output) ||
    toolPrefix.test(output);
  if (!isRejected) return null;

  return {
    tsOrJsInPythonRepl:
      result.name === 'Repl' &&
      /TypeScript\/JavaScript|TypeScript|JavaScript|Python runtime/i.test(output),
  };
}

function buildRepeatedRejectionReminder(toolName: string, state: ToolRejectionState): string {
  const base =
    `You've been rejected by ${toolName} ${state.count} times in this user request. ` +
    `Stop retrying the same shape. Last rejection: ${state.lastOutput.slice(0, 500)}`;

  if (state.tsOrJsInPythonRepl) {
    return `<system-reminder>${base}\n\n` +
      `Specific correction: Repl is Python only. For TypeScript harness/source-code work, use Python Repl to ` +
      `read/edit files via fs.* and validate with shell.run("npm run typecheck") or shell.run("npx tsx <file>"). ` +
      `Do not submit TypeScript syntax to Repl again.</system-reminder>`;
  }

  return `<system-reminder>${base}\n\n` +
    `Switch approach before calling ${toolName} again: use a different tool, inspect the expected shape, or simplify ` +
    `the call. Do not repeat the same failing payload.</system-reminder>`;
}
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
    onFileMutated,
    planFilePathRef,
    permissionModeRef,
    taskMode = 'normal',
  } = params;

  const allTools: ToolDefinition[] = registry.definitions();
  const replEnabled = allTools.some(t => t.name === 'Repl');
  const contextLimit = router.current.contextWindow;
  const compactTokenThreshold = Math.floor(contextLimit * compactThreshold);
  let turnCount = 0;
  let importanceAccumulator = 0;
  // Recovery loop tracker — increments on all-failed turns, resets on success.
  // Drives a system-reminder that forces diagnosis before retry, and at 2+
  // nudges a vault.explore(error_text) to check if we've hit this before
  // (memory-first recovery — not in CC/oh-my-pi's version).
  let consecutiveFailureTurns = 0;
  // Max-tokens recovery counter â€” when the model's output is truncated by
  // max_tokens, the harness injects a synthetic user message and loops back.
  // Capped at 3 to prevent infinite loops on genuinely oversized responses.
  // Pattern from Claude Code query.ts:1185-1257.
  let maxOutputRecoveryCount = 0;
  // Same-tool rejection steering. If the model keeps hitting the same
  // validation wall (for example TypeScript in the Python Repl), inject a
  // targeted reminder into the next model call instead of letting it hammer
  // the identical bad shape for another turn.
  const toolRejectionStates = new Map<string, ToolRejectionState>();
  let repeatedToolRejectionReminder: string | null = null;

  // Reset doom loop tracking on new user input
  resetDoomLoop();

  while (turnCount < maxTurns) {
    turnCount++;

    // ── Turn-scoped shape aggregator ─────────────────────────────────
    // Fresh per turn iteration. Tools (currently only Repl) mutate this
    // in place via ToolContext.turnStats. Logged as a `turn_metrics`
    // session event at both exit paths below — after tool execution
    // (before `continue`) and at text-only turn completion. Part of the
    // schema-enforced Repl composition measurement.
    const turnStats: TurnStats = {
      replCalls: 0,
      anyComposed: false,
      anyMicro: false,
      committed: false,
    };
    const turnCtx: ToolContext = {
      ...toolContext,
      log: (entry) => session?.log(entry),
      turnStats,
    };

    // Live-read permissionMode from ref each turn so ExitPlanMode approval
    // takes effect immediately (not stale from agentLoop call-site).
    const permissionMode: PermissionMode = permissionModeRef?.current ?? params.permissionMode ?? 'default';

    // ── CACHE-PRESERVING COPY (Pi/CC pattern, 2026-04-26) ───────────
    // The canonical `messages` array is append-only between turns. All
    // pre-LLM-call transforms (strip synthetics, heal orphans, prune tool
    // outputs) operate on a COPY so the Anthropic cache prefix is never
    // broken. Without this, pruneToolOutputs' `block.content = "[output
    // pruned]"` mutates shared objects, invalidating the cache and forcing
    // the entire 130K+ conversation to re-send at full price.
    // See Pi anthropic.ts and CC query.ts:365 for the same pattern.
    const queryMessages = messages.map(m => ({
      ...m,
      content: Array.isArray(m.content)
        ? (m.content as ContentBlock[]).map(b => ({ ...b }))
        : m.content,
    }));
    stripSyntheticFromMessages(queryMessages);
    healOrphanedToolUses(queryMessages);

    // Reset per-turn nudge counters (sequential read tracking, etc.)
    resetNudgeCounters();

    // ── No-injection architecture (2026-04-19) ─────────────────────────
    // Per-turn preflight, proprioception, and warm-context refresh all removed.
    // The model pulls memory on-demand via vault.* in the Repl. The status bar
    // shows context utilization to the user; the model doesn't need to be told.
    // Auto-compaction (full summarize-and-replace) stays disabled — never
    // compact mid-task. Microcompact below is a lighter pass that prunes old
    // tool_result bodies only, never touches conversation.

    // ── MICROCOMPACT (stopgap) ─────────────────────────────────────────
    // When cumulative history crosses a threshold, prune old tool_result
    // bodies to '[output pruned]' (keeping the call skeleton intact so the
    // model knows what tools were used). Protects the most recent 40k tokens
    // of tool output. Non-LLM, pure bookkeeping. STOPGAP — the final form is
    // kernel-level handle-based rehydration (see RUNNING.md deferred work).
    const preCompactTokens = estimateTokens(queryMessages);
    if (preCompactTokens > 100_000) {
      pruneToolOutputs(queryMessages);
    }

    // ── RESULT BUDGET ──────────────────────────────────────
    const budgetedMessages = applyResultBudget(queryMessages, maxResultChars);

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
    } else {
      // Default mode = codemode (A8). The model sees Repl + plan-mode
      // switchers + subagent delegation only. Every file-nav / edit /
      // shell / web / vault / project tool lives INSIDE the Repl
      // namespace — the model reaches them via fs.*, shell.run, web.*,
      // vault.*, codebase.*, research.*, rlm_call, rlm_batch, say, ask.
      //
      // Why runtime-filter and not destructive registry strip: research,
      // plan, and explore modes share the same registry. Stripping tools
      // at registration time would break their mode-specific allowlists.
      // By filtering per-turn at this layer (mirroring the existing
      // research/plan/explore branches above), each mode's tool set is
      // independent and research/plan/explore keep working unchanged.
      //
      // Why keep Agent in the allowlist: subagent delegation is its own
      // architectural capability (spawns a fresh context), not a file-nav
      // escape hatch. Repl composition and Agent delegation are
      // complementary, not alternatives.
      //
      // See CODEMODE_ROADMAP.md §A8 and the all-righty-okay-so-lexical-
      // island plan for the full rationale.
      const CODEMODE_DEFAULT = new Set([
        'Repl', 'EnterPlanMode', 'ExitPlanMode', 'Agent',
      ]);
      activeTools = allTools.filter(t => CODEMODE_DEFAULT.has(t.name));
    }

    // ── Research mode reminder ────────────────────────────────────────
    // Wrapped in a synthetic marker so the NEXT turn's stripSynthetic removes
    // it cleanly. Previously used `content.includes('RESEARCH mode')` dedup,
    // which prevented double-injection but also meant the reminder stayed
    // baked into the message forever — leaking across mode transitions.
    if (permissionMode === 'research') {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        const reminder = `<system-reminder>RESEARCH mode. Repl-only via \`research.*\`: discover, ingest, fetch, extract, synthesize, save. Pipeline: discover → ingest → extract → synthesize → save. Pick 5-10 sources from each discover, not all. \`research.save(slug)\` is REQUIRED to exit.</system-reminder>`;
        budgetedMessages[lastUserIdx] = {
          ...budgetedMessages[lastUserIdx]!,
          content: `${wrapSynthetic('research-mode', reminder)}\n\n${content}`,
        };
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
        const reminder = `<system-reminder>EXPLORE mode. Repl, VaultAdd, ProjectSave only. No file mods, no shell. For changes: Alt+Z to exit.</system-reminder>`;
        budgetedMessages[lastUserIdx] = {
          ...budgetedMessages[lastUserIdx]!,
          content: `${wrapSynthetic('explore-mode', reminder)}\n\n${content}`,
        };
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
        const reminder = `<system-reminder>${getPlanModeSparseReminder(planFilePath)}</system-reminder>`;
        budgetedMessages[lastUserIdx] = {
          ...budgetedMessages[lastUserIdx]!,
          content: `${wrapSynthetic('plan-mode', reminder)}\n\n${content}`,
        };
      }
    }

    // ── Recovery reminder (failure classifier) ────────────────────────
    // If the previous turn produced only tool failures, inject a nudge forcing
    // diagnosis before retry. At 2+ consecutive failed turns, add a memory-first
    // directive: call vault.explore on the error text before trying again.
    if (consecutiveFailureTurns > 0) {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        const reminder = consecutiveFailureTurns >= 2
          ? `<system-reminder>Recovery: ${consecutiveFailureTurns} consecutive failed-tool turns. Before retrying, (1) call \`vault.explore("<short description of the error>")\` to check if we've hit this pattern before, and (2) state your hypothesis about WHY in one sentence. Do NOT repeat the same tool call — something about the approach is wrong.</system-reminder>`
          : `<system-reminder>Recovery: last tool call failed. State your hypothesis about why in one sentence before retrying. Don't repeat the same call verbatim.</system-reminder>`;
        budgetedMessages[lastUserIdx] = {
          ...budgetedMessages[lastUserIdx]!,
          content: `${wrapSynthetic('recovery', reminder)}\n\n${content}`,
        };
      }
    }

    // Same-tool repeated-rejection steering. classifyToolRejection (above)
    // runs after each tool execution and bumps a per-tool counter; when the
    // model has been rejected by the same tool 2+ times in this user
    // request, we prepend a targeted reminder. One-shot per turn — the
    // reminder fires once, then clears so we don't spam every subsequent
    // turn with the same nag if the model has already routed elsewhere.
    if (repeatedToolRejectionReminder) {
      let lastUserIdx = -1;
      for (let i = budgetedMessages.length - 1; i >= 0; i--) {
        if (budgetedMessages[i]!.role === 'user') { lastUserIdx = i; break; }
      }
      if (lastUserIdx >= 0 && typeof budgetedMessages[lastUserIdx]!.content === 'string') {
        const content = budgetedMessages[lastUserIdx]!.content as string;
        budgetedMessages[lastUserIdx] = {
          ...budgetedMessages[lastUserIdx]!,
          content: `${wrapSynthetic('rejection-steering', repeatedToolRejectionReminder)}\n\n${content}`,
        };
      }
      repeatedToolRejectionReminder = null;
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

          case 'cutoff_warning': {
            // Batch 3 — append a clearly-tagged marker to the assistant
            // text so the next turn's context shows the model "you got
            // cut off, continue from where you left off." The tag prefix
            // [harness:cutoff ...] is recognizable noise the model can
            // distinguish from its own writing — matches CC's synthetic
            // assistant message pattern (services/api/claude.ts:2270).
            // Yield to UI for surfacing; log for cutoff-frequency
            // telemetry (we want to know if max_tokens hits become
            // common after the cap lift, which would suggest re-tuning).
            const marker =
              `\n\n[harness:cutoff reason="${event.reason}"] ${event.message}`;
            assistantText += marker;
            yield { type: 'cutoff_warning', reason: event.reason, message: event.message };
            session?.log({
              type: 'cutoff_warning',
              reason: event.reason,
              message: event.message,
              timestamp: Date.now(),
            });
            break;
          }

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
          executedResults = await executeTools(approvedCalls, registry, turnCtx, hooks, vault?.vaultPath, maxSubagents);
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

      // Update recovery tracker: all-failed turn increments, any-success resets.
      if (executedResults.length > 0) {
        const anySuccess = executedResults.some(r => !r.isError);
        const anyFailure = executedResults.some(r => r.isError);
        if (anyFailure && !anySuccess) {
          consecutiveFailureTurns++;
        } else if (anySuccess) {
          consecutiveFailureTurns = 0;
        }
      }

      // Apply contextual REPL nudges to tool results
      applyNudges(executedResults, replEnabled);

      // ── Same-tool rejection tracking (Phase B) ────────────────────────
      // For every executed result, classify whether it's a structural
      // rejection (Repl/Vault/AST guard rejected the input shape). If so,
      // bump the per-tool counter and capture the latest rejection text.
      // Once a tool has been rejected ≥2 times in this user request,
      // arm `repeatedToolRejectionReminder` for injection on the NEXT
      // turn's pre-stream block (above). The reminder is one-shot —
      // fires once, clears itself, doesn't keep firing for the rest of
      // the request even if the counter stays high. Substrate also
      // useful for Batch 6-7 gotchas (per-turn synthetic reminders).
      for (const result of executedResults) {
        const cls = classifyToolRejection(result);
        if (!cls) continue;
        const prev = toolRejectionStates.get(result.name) ?? {
          count: 0,
          lastOutput: '',
          tsOrJsInPythonRepl: false,
        };
        const next: ToolRejectionState = {
          count: prev.count + 1,
          lastOutput: result.output,
          tsOrJsInPythonRepl: prev.tsOrJsInPythonRepl || cls.tsOrJsInPythonRepl,
        };
        toolRejectionStates.set(result.name, next);
        if (next.count >= 2) {
          repeatedToolRejectionReminder = buildRepeatedRejectionReminder(result.name, next);
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
            // Full output for subagent capture / anyone who needs the complete
            // tool result. UI consumers should keep reading `output` (short).
            output_full: result.output,
            isError: result.isError,
          };
          session?.log({
            type: 'tool_result',
            id: result.id, name: result.name,
            output: result.output.slice(0, 5000),
            isError: result.isError,
            timestamp: Date.now(),
          });
        }
      }

      // Log turn_metrics before continuing to next turn. Captures the
      // schema-enforced Repl composition signal for this turn (how many
      // Repl calls, whether any were composed / micro, whether done()
      // fired). turnStats is reset fresh at the top of the next iteration.
      session?.log({
        type: 'turn_metrics',
        turn_index: turnCount,
        repl_calls: turnStats.replCalls,
        any_composed: turnStats.anyComposed,
        any_micro: turnStats.anyMicro,
        committed: turnStats.committed,
        timestamp: Date.now(),
      });

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
          // Updated 2026-04-22: Repl tool_use input is now {plan, operations[]}
          // not {code}. Concatenate every op's code field for the research-mode
          // pattern scan. If the assistant message predates the schema change
          // and has a legacy .code field, fall back to that so old sessions
          // don't mis-classify.
          const tu = block as {
            name?: string;
            input?: { code?: string; operations?: Array<{ code?: string }> };
          };
          if (tu.name !== 'Repl' || !tu.input) continue;
          let code = '';
          if (Array.isArray(tu.input.operations)) {
            code = tu.input.operations
              .map((op) => (typeof op?.code === 'string' ? op.code : ''))
              .join('\n');
          } else if (typeof tu.input.code === 'string') {
            code = tu.input.code;
          }
          if (!code) continue;
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

    // Log turn_metrics for text-only turn completion. Most text-only turns
    // will have zero Repl calls (model just chatting), which itself is
    // telemetry — zero-repl-turn frequency is the baseline against which
    // composed-turn rates are measured.
    session?.log({
      type: 'turn_metrics',
      turn_index: turnCount,
      repl_calls: turnStats.replCalls,
      any_composed: turnStats.anyComposed,
      any_micro: turnStats.anyMicro,
      committed: turnStats.committed,
      timestamp: Date.now(),
    });

    // ── POSTFLIGHT (gated on work-worthy turns only) ─────────────────
    // Previously ran a silent cheapCall every clean turn including chat.
    // Now only runs when this turn produced or consumed tool output, which
    // is the only signal that durable knowledge might exist to extract.
    const turnHadToolWork = messages.slice(-3).some(m => {
      if (typeof m.content === 'string') return false;
      return (m.content as ContentBlock[]).some(b => b.type === 'tool_use' || b.type === 'tool_result');
    });
    if (turnHadToolWork) {
      importanceAccumulator = await runPostflight(
        messages, projectBrain, vault, importanceAccumulator, router,
      );
      session?.log({
        type: 'postflight',
        importance: importanceAccumulator,
        reflected: false,
        timestamp: Date.now(),
      });
    }

    // ── MAX_TOKENS RECOVERY (Claude Code query.ts:1185-1257) ─────────
    // When the model's output was truncated by max_tokens, inject a
    // synthetic user message telling it to continue, then loop back.
    // The [harness:cutoff] marker was appended by the stream consumer
    // above (L443-459). Recovery message is CC's prod-proven phrasing:
    // terse, no-recap, mid-thought pickup. Capped at 3 attempts.
    const MAX_OUTPUT_RECOVERY_LIMIT = 3;
    if (assistantText.includes('[harness:cutoff')) {
      maxOutputRecoveryCount++;
      if (maxOutputRecoveryCount <= MAX_OUTPUT_RECOVERY_LIMIT) {
        messages.push({
          role: 'user',
          content:
            'Output token limit hit. Resume directly — no apology, ' +
            'no recap of what you were doing. Pick up mid-thought ' +
            'if that is where the cut happened. Break remaining ' +
            'work into smaller pieces.',
        });
        session?.log({
          type: 'max_output_recovery',
          attempt: maxOutputRecoveryCount,
          timestamp: Date.now(),
        });
        yield { type: 'max_output_recovery', attempt: maxOutputRecoveryCount, maxAttempts: MAX_OUTPUT_RECOVERY_LIMIT };
        yield {
          type: 'turn_complete',
          turn: turnCount,
          tokenEstimate: estimateTokens(messages),
        };
        continue;
      }
      // Recovery exhausted after 3 attempts — fall through to normal return.
      session?.log({
        type: 'max_output_recovery_exhausted',
        attempts: maxOutputRecoveryCount,
        timestamp: Date.now(),
      });
    }

    const finalTokens = estimateTokens(messages);
    yield { type: 'turn_complete', turn: turnCount, tokenEstimate: finalTokens };

    return;
  }

  yield { type: 'error', error: new Error(`Max turns exceeded (${maxTurns})`) };
}
