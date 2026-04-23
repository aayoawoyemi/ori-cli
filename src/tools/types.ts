import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { SessionEntry } from '../session/storage.js';

// Turn-scoped shape aggregator. Populated by tools (currently only Repl) as
// side-effects of execution. loop.ts allocates a fresh instance at the top
// of each turn iteration and logs a `turn_metrics` session event at turn
// end based on the accumulated values. Mutable on purpose — each tool call
// within a turn updates shared state instead of each tool returning its own
// telemetry. Added 2026-04-22 for the composition measurement experiment.
export interface TurnStats {
  replCalls: number;
  anyComposed: boolean;
  anyMicro: boolean;
  committed: boolean;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  // Optional session logger. When present, tools can emit per-execution
  // telemetry events (repl_shape, done_committed, etc.) without going
  // through loop.ts. loop.ts injects this as a thin wrapper around
  // session.log when it builds the per-turn toolContext.
  log?: (entry: SessionEntry) => void;
  // The tool_use id of the call currently being executed. Injected by
  // executeSingle per tool call so tools can correlate their telemetry
  // events with the matching tool_call / tool_result entries in the
  // session log. Not present when a tool is called outside the normal
  // loop path (tests, manual invocation).
  toolUseId?: string;
  // Turn-scoped aggregator; see TurnStats. Shared mutable ref — tools
  // update in place, loop.ts reads at turn end.
  turnStats?: TurnStats;
}

export interface Tool {
  /** Unique tool name (e.g. 'Bash', 'Read'). */
  readonly name: string;

  /** Human-readable description for the model. */
  readonly description: string;

  /** Whether this tool only reads (safe for parallel execution). */
  readonly readOnly: boolean;

  /** Generate the tool definition sent to the model. */
  definition(): ToolDefinition;

  /** Execute the tool with the given input. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
