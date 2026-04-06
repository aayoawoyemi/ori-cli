/**
 * Dynamic tool exposure — phase-gated tool sets.
 *
 * Instead of exposing all 16+ tools on every API call (3-6K tokens in schemas),
 * expose only the tools relevant to the current task phase.
 *
 * Phases:
 *   explore — understanding the codebase (Repl only, or Read/Grep/Glob if no REPL)
 *   edit    — making changes (Edit, Write, Repl for verification)
 *   verify  — checking results (Repl, Bash for tests/tsc)
 *   full    — all tools (fallback, backwards-compatible)
 *
 * State machine transitions:
 *   Start → explore
 *   explore → edit   (when model emits Edit/Write)
 *   edit → verify    (when model emits text-only after edits, or Bash/Repl after edits)
 *   any → full       (if model requests a tool not in current phase set — widen, don't fail)
 *
 * The fallback-to-full prevents wasted turns from tool-not-found errors.
 */
import type { ToolDefinition } from '../router/types.js';
import type { ToolRegistry } from './registry.js';

export type TaskPhase = 'lean' | 'full';

// Lean: minimal tool set for coding tasks. 3 tools instead of 16+.
// Saves ~3-5K tokens/turn in tool schema overhead.
const REPL_LEAN_TOOLS = new Set(['Repl', 'Edit', 'Write', 'Bash']);
const BARE_LEAN_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);

/**
 * Get tool definitions filtered by current phase.
 * Returns ALL tools if phase is 'full'.
 */
export function getToolsForPhase(
  registry: ToolRegistry,
  phase: TaskPhase,
  replEnabled: boolean,
): ToolDefinition[] {
  if (phase === 'full') return registry.definitions();
  const allowed = replEnabled ? REPL_LEAN_TOOLS : BARE_LEAN_TOOLS;
  return registry.definitions().filter(t => allowed.has(t.name));
}

/**
 * Simple phase tracker.
 *
 * Starts in 'lean'. Widens to 'full' if model requests a tool not in lean set.
 */
export class PhaseTracker {
  private _phase: TaskPhase;

  constructor(initialPhase: TaskPhase = 'lean') {
    this._phase = initialPhase;
  }

  get phase(): TaskPhase { return this._phase; }

  /**
   * Check if a tool call requires widening to full.
   */
  onToolCall(toolName: string, replEnabled: boolean): TaskPhase {
    if (this._phase === 'full') return 'full';
    const allowed = replEnabled ? REPL_LEAN_TOOLS : BARE_LEAN_TOOLS;
    if (!allowed.has(toolName)) {
      this._phase = 'full';
    }
    return this._phase;
  }
}
