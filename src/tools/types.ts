import type { ToolDefinition, ToolResult } from '../router/types.js';

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
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
