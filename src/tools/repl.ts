/**
 * Repl tool — lets the model execute Python in the body subprocess.
 *
 * Wraps bridge.exec() as a standard Tool. When the model calls this,
 * it gets access to the full REPL namespace: codebase, vault, rlm_call,
 * rlm_batch, safe builtins. Output comes back as tool_result.
 */
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';

export class ReplTool implements Tool {
  readonly name = 'Repl';
  readonly description =
    'Primary tool for all code exploration, file reading, memory retrieval, and compositional reasoning. Use this first — before Bash, before anything else. Available: codebase.search/get_context/find_symbol/list_files, fs.read(path), vault.query_ranked/explore, rlm_call/rlm_batch. Composes multiple operations in one call. Far more efficient than shell commands for reading or searching.';
  readonly readOnly = false;

  constructor(private getHandle: () => ReplHandle | null) {}

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Python code to execute. Use print() to return output. Available: fs.read(path, offset?, limit?) — read any file by absolute or relative path; codebase.search/top_files/get_context/show_dependents/find_symbol/hits/communities, vault.query_ranked/query_important/query_warmth/explore/status, rlm_call(slice, question, budget), rlm_batch([(slice, q), ...], budget_per). Imports are forbidden; the namespace is pre-loaded.',
          },
        },
        required: ['code'],
      },
    };
  }

  async execute(
    input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const handle = this.getHandle();
    if (!handle) {
      return {
        id: '',
        name: this.name,
        output: 'REPL not available. Set `repl.enabled: true` in config and restart.',
        isError: true,
      };
    }

    const code = (input.code as string) ?? '';
    if (!code.trim()) {
      return { id: '', name: this.name, output: 'Empty code block.', isError: true };
    }

    const result = await handle.exec({ code }, _ctx.signal);

    if (result.rejected) {
      return {
        id: '',
        name: this.name,
        output: `AST guard rejected: ${result.rejected.reason}`,
        isError: true,
      };
    }

    if (result.timed_out) {
      return {
        id: '',
        name: this.name,
        output: `Timed out after ${result.duration_ms}ms`,
        isError: true,
      };
    }

    // Format output for the model
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout.trimEnd());
    if (result.stderr) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.exception) parts.push(`[exception]\n${result.exception.trimEnd()}`);

    const statsParts: string[] = [`${result.duration_ms}ms`];
    if (result.rlm_stats && result.rlm_stats.call_count > 0) {
      statsParts.push(
        `${result.rlm_stats.call_count} rlm calls`,
        `${result.rlm_stats.total_tokens} tokens`,
      );
    }
    parts.push(`(${statsParts.join(' · ')})`);

    return {
      id: '',
      name: this.name,
      output: parts.join('\n\n') || '(no output)',
      isError: result.exception !== null,
    };
  }
}
