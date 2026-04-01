import type { ToolCall, ToolResult } from '../router/types.js';
import type { ToolContext } from './types.js';
import type { ToolRegistry } from './registry.js';

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

  // Run all read-only tools in parallel
  if (readCalls.length > 0) {
    const readResults = await Promise.all(
      readCalls.map(tc => executeSingle(tc, registry, ctx)),
    );
    results.push(...readResults);
  }

  // Run write tools serially
  for (const tc of writeCalls) {
    const result = await executeSingle(tc, registry, ctx);
    results.push(result);
  }

  return results;
}

async function executeSingle(
  tc: ToolCall,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(tc.name);
  if (!tool) {
    return {
      id: tc.id,
      name: tc.name,
      output: `Unknown tool: ${tc.name}`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(tc.input, ctx);
    return { ...result, id: tc.id };
  } catch (err) {
    return {
      id: tc.id,
      name: tc.name,
      output: `Tool execution failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}
