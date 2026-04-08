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
 * Execute tool calls with read/write partitioning and doom loop detection.
 * Read-only tools run in parallel. Write tools run serially.
 */
export async function executeTools(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  ctx: ToolContext,
  hooks?: HooksConfig,
  vaultPath?: string,
  maxSubagents = 5,
): Promise<ToolResult[]> {
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
  if (results.length === toolCalls.length) return results;

  // Filter out doom-looped calls
  const validCalls = toolCalls.filter(tc => !results.some(r => r.id === tc.id));

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

  // Separate agent calls from other read-only tools
  const agentCalls = readCalls.filter(tc => tc.name === 'Agent');
  const otherReads = readCalls.filter(tc => tc.name !== 'Agent');

  // Other reads: unbounded parallel (fast filesystem ops)
  if (otherReads.length > 0) {
    const readResults = await Promise.all(
      otherReads.map(tc => executeSingle(tc, registry, ctx, hooks, vaultPath)),
    );
    results.push(...readResults);
  }

  // Agent calls: bounded parallel (each spawns a child process)
  if (agentCalls.length > 0) {
    const agentResults = await runBounded(
      agentCalls,
      maxSubagents,
      tc => executeSingle(tc, registry, ctx, hooks, vaultPath),
    );
    results.push(...agentResults);
  }

  // Run write tools serially
  for (const tc of writeCalls) {
    const result = await executeSingle(tc, registry, ctx, hooks, vaultPath);
    results.push(result);
  }

  return results;
}

/**
 * Run async tasks with bounded concurrency.
 * At most `limit` tasks execute simultaneously; the rest queue.
 */
async function runBounded(
  items: ToolCall[],
  limit: number,
  fn: (item: ToolCall) => Promise<ToolResult>,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p = (async () => {
      const result = await fn(item);
      results.push(result);
    })();
    executing.add(p);
    p.finally(() => executing.delete(p));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

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
    const result = abortPromise
      ? await Promise.race([tool.execute(tc.input, ctx), abortPromise])
      : await tool.execute(tc.input, ctx);
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
