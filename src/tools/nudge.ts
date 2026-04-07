/**
 * Contextual REPL nudges — appended to tool results when usage patterns
 * suggest REPL composition would be more efficient.
 *
 * Nudges fire at the moment of decision, right in the tool result the model
 * is about to reason over. Not a system prompt instruction 10K tokens away.
 *
 * Three patterns detected:
 *   1. Grep/search with many matches → cluster_by_file + rlm_batch
 *   2. Sequential Read calls in one turn → codebase.get_context multi-file
 *   3. Large file Read → focused get_context with line targeting
 */

interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

// Track sequential reads within a turn
let readCountThisTurn = 0;

/** Reset the per-turn counter. Call at the start of each user turn. */
export function resetNudgeCounters(): void {
  readCountThisTurn = 0;
}

/**
 * Inspect tool results and append contextual REPL hints when patterns
 * suggest composition would be more efficient. Mutates results in place.
 *
 * Only fires when REPL is enabled — no point nudging toward a tool
 * the model doesn't have.
 */
export function applyNudges(results: ToolResult[], replEnabled: boolean): void {
  if (!replEnabled) return;

  for (const result of results) {
    if (result.isError) continue;

    const nudge = detectNudge(result);
    if (nudge) {
      result.output += `\n\n💡 ${nudge}`;
    }
  }
}

function detectNudge(result: ToolResult): string | null {
  const { name, output } = result;

  // Pattern 1: Grep/Glob with many matches
  if (name === 'Grep' || name === 'Glob') {
    const lineCount = output.split('\n').filter(l => l.trim()).length;
    if (lineCount >= 15) {
      return `${lineCount}+ matches across multiple files. Consider: Repl → codebase.search() → cluster_by_file() → rlm_batch() for synthesis.`;
    }
  }

  // Pattern 2: Sequential Read calls (3+ in one turn)
  if (name === 'Read') {
    readCountThisTurn++;
    if (readCountThisTurn >= 3) {
      return `${readCountThisTurn} sequential reads this turn. codebase.get_context() can fetch multiple files in one Repl call.`;
    }
  }

  // Pattern 3: Large file Read (>200 lines)
  if (name === 'Read') {
    const lineCount = output.split('\n').length;
    if (lineCount > 200) {
      return `Large file (${lineCount} lines). Repl → codebase.get_context(file, [target_lines], window=5) for focused slices.`;
    }
  }

  return null;
}
