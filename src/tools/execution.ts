import type { ToolCall, ToolResult } from '../router/types.js';
import type { ToolContext } from './types.js';
import type { ToolRegistry } from './registry.js';
import type { HooksConfig } from '../config/types.js';
import { runHooks } from '../hooks/runner.js';

// ── Doom Loop Detection ─────────────────────────────────────────────────────
// Track recent tool calls. If the same tool is called with identical input
// 3 times in a row, it's stuck. Return an error instead of burning tokens.
// Adopted from OpenCode/KiloCode.

const DOOM_LOOP_THRESHOLD = 3;

interface CallSignature {
  name: string;
  inputHash: string;
}

const recentCalls: CallSignature[] = [];

function hashInput(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

function checkDoomLoop(tc: ToolCall): boolean {
  const sig: CallSignature = { name: tc.name, inputHash: hashInput(tc.input) };

  recentCalls.push(sig);
  // Only keep the last DOOM_LOOP_THRESHOLD entries
  if (recentCalls.length > DOOM_LOOP_THRESHOLD) {
    recentCalls.shift();
  }

  if (recentCalls.length < DOOM_LOOP_THRESHOLD) return false;

  // Check if all recent calls are identical
  const first = recentCalls[0];
  return recentCalls.every(c => c.name === first.name && c.inputHash === first.inputHash);
}

/** Reset doom loop tracking (call on new user message). */
export function resetDoomLoop(): void {
  recentCalls.length = 0;
}

// ── Tool Execution ──────────────────────────────────────────────────────────

/**
 * Result of executeTools — list of tool results plus optional steering
 * messages captured mid-batch. Steering is a Pi-parity primitive (Batch 4):
 * the user can interrupt a long-running tool batch by typing into the
 * steering queue, and the next tool finish point picks up the messages,
 * aborts remaining tools (returning skipped results for them), and surfaces
 * the captured steering for the loop to inject as the next user message.
 */
export interface ExecuteToolsResult {
  results: ToolResult[];
  steeringMessages?: string[];
}

/**
 * Execute tool calls with read/write partitioning, doom loop detection, and
 * mid-batch steering interrupt.
 *
 * Read-only tools run in parallel. Write tools run serially. After each
 * tool finishes, `getSteeringMessages` (if provided) is called; if it
 * returns a non-empty array, the batch's AbortController fires, remaining
 * write tools get a "skipped: user steered" result,
 * and the captured steering messages are returned in `result.steeringMessages`
 * so the loop can inject them as the next user message before re-streaming.
 *
 * The mid-batch interrupt does NOT cancel reads already in flight (they
 * run as a Promise.all that's already kicked off). It interrupts BETWEEN
 * reads → writes. Pi’s pattern is the same — the abort
 * check happens between batch phases, not inside a phase.
 */
export async function executeTools(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  hooks?: HooksConfig,
  vaultPath?: string,
  getSteeringMessages?: () => Promise<string[]> | string[],
): Promise<ExecuteToolsResult> {
  const results: ToolResult[] = [];

  for (const tc of toolCalls) {
    // Doom loop check
    if (checkDoomLoop(tc)) {
      results.push({
        id: tc.id,
        name: tc.name,
        output: `Doom loop detected: ${tc.name} called ${DOOM_LOOP_THRESHOLD} times with identical input. Stopping to prevent infinite loop. Try a different approach.`,
        isError: true,
      });
      continue;
    }
  }

  // If all calls were doom-looped, return early
  if (results.length === toolCalls.length) return { results };

  // Filter out doom-looped calls
  const validCalls = toolCalls.filter(tc => !results.some(r => r.id === tc.id));

  // Per-batch AbortController layered on top of ctx.signal. Tools see a
  // combined signal; mid-batch steering check fires this controller to
  // skip remaining work without affecting the user's outer signal.
  const batchAbort = new AbortController();
  const combinedSignal: AbortSignal = ctx.signal
    ? anySignal([ctx.signal, batchAbort.signal])
    : batchAbort.signal;
  const batchCtx: ToolContext = { ...ctx, signal: combinedSignal };

  // Helper: drain steering, return whether we should abort.
  const checkSteering = async (): Promise<string[] | null> => {
    if (!getSteeringMessages) return null;
    const msgs = await getSteeringMessages();
    if (msgs.length === 0) return null;
    batchAbort.abort();
    return msgs;
  };

  // Skipped-result emitter — used when remaining tools are short-circuited
  // by mid-batch steering. Maintains tool_use/tool_result pairing the API
  // requires (no orphaned tool_use IDs) without running the actual tool.
  const skippedResult = (tc: ToolCall): ToolResult => ({
    id: tc.id,
    name: tc.name,
    output: 'Skipped: user steered the batch mid-execution. The steering message is the next user input.',
    isError: false,
  });

  // Partition into read-only and write groups
  const readCalls: ToolCall[] = [];
  const writeCalls: ToolCall[] = [];

  for (const tc of validCalls) {
    if (registry.isReadOnly(tc.name)) {
      readCalls.push(tc);
    } else {
      writeCalls.push(tc);
    }
  }

  // Read-only tools: unbounded parallel (fast filesystem ops)
  // Agent-specific bounded-parallel block removed 2026-05-03 â€” AgentTool deleted.
  if (readCalls.length > 0) {
    const readResults = await Promise.all(
      readCalls.map(tc => executeSingle(tc, registry, batchCtx, hooks, vaultPath)),
    );
    results.push(...readResults);

    const steering = await checkSteering();
    if (steering) {
      for (const tc of writeCalls) results.push(skippedResult(tc));
      return { results, steeringMessages: steering };
    }
  }

  // Run write tools serially. Steering is checked AFTER each — write tools
  // are typically the long-running ones (Repl batches with many cells), so
  // mid-write steering is the most-frequent interrupt point.
  for (let i = 0; i < writeCalls.length; i++) {
    const tc = writeCalls[i];
    const result = await executeSingle(tc, registry, batchCtx, hooks, vaultPath);
    results.push(result);

    const steering = await checkSteering();
    if (steering) {
      // Skip remaining write tools (i+1..end)
      for (let j = i + 1; j < writeCalls.length; j++) {
        results.push(skippedResult(writeCalls[j]));
      }
      return { results, steeringMessages: steering };
    }
  }

  return { results };
}

/**
 * Combine multiple AbortSignals into one. Fires when any of the inputs
 * fires. Polyfill for AbortSignal.any (Node 20+) — the runtime version
 * is preferred when available since it's lighter weight.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  // Prefer the standard if available (Node 20+, browsers)
  if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === 'function') {
    return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Run async tasks with bounded concurrency.
 * At most `limit` tasks execute simultaneously; the rest queue.
 */
async function executeSingle(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
  hooks?: HooksConfig,
  vaultPath?: string,
): Promise<ToolResult> {
  // Check abort before starting
  if (ctx.signal?.aborted) {
    return {
      id: tc.id,
      name: tc.name,
      output: 'Interrupted by user',
      isError: false,
    };
  }

  const tool = registry.get(tc.name);
  if (!tool) {
    return {
      id: tc.id,
      name: tc.name,
      output: `Unknown tool: ${tc.name}`,
      isError: true,
    };
  }

  // ── PreToolUse hook ─────────────────────────────────────────────────
  if (hooks) {
    const hookResult = await runHooks('preToolUse', hooks, { cwd: ctx.cwd, vaultPath }, {
      tool: tc.name,
      input: tc.input,
    });
    if (hookResult.blocked) {
      return {
        id: tc.id,
        name: tc.name,
        output: hookResult.blockMessage ?? 'Blocked by preToolUse hook.',
        isError: true,
      };
    }
  }

  try {
    // Race tool execution against abort signal so Ctrl+C / Esc can interrupt stuck tools
    const abortPromise = ctx.signal
      ? new Promise<never>((_, reject) => {
          if (ctx.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
          ctx.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        })
      : null;
    // Inject the current tool_use id into ctx so tools can correlate
    // telemetry events (repl_shape, done_committed) with the matching
    // tool_call / tool_result entries in the session log.
    const ctxWithId = { ...ctx, toolUseId: tc.id };
    const result = abortPromise
      ? await Promise.race([tool.execute(tc.input, ctxWithId), abortPromise])
      : await tool.execute(tc.input, ctxWithId);
    const finalResult = { ...result, id: tc.id };

    // ── PostToolUse hook (fire-and-forget) ─────────────────────────────
    if (hooks) {
      runHooks('postToolUse', hooks, { cwd: ctx.cwd, vaultPath }, {
        tool: tc.name,
        input: tc.input,
        output: result.output.slice(0, 5000),
        isError: result.isError,
      }).catch(() => {});
    }

    return finalResult;
  } catch (err) {
    if ((err as Error).name === 'AbortError' || ctx.signal?.aborted) {
      return {
        id: tc.id,
        name: tc.name,
        output: 'Interrupted by user',
        isError: false,
      };
    }
    return {
      id: tc.id,
      name: tc.name,
      output: `Tool execution failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
