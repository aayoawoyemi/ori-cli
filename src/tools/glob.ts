import { glob as globFn } from 'glob';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class GlobTool implements Tool {
  readonly name = 'Glob';
  readonly description = 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Use for finding files by name or extension.';
  readonly readOnly = true;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern to match (e.g., "**/*.ts", "src/**/*.tsx").',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to working directory.',
          },
        },
        required: ['pattern'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = resolve(ctx.cwd, (input.path as string) || '.');

    try {
      const matches = await globFn(pattern, {
        cwd: searchPath,
        nodir: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      });

      if (matches.length === 0) {
        return { id: '', name: this.name, output: 'No files found matching pattern.', isError: false };
      }

      const output = matches.slice(0, 500).join('\n');
      const suffix = matches.length > 500 ? `\n\n(${matches.length} total, showing first 500)` : '';

      return { id: '', name: this.name, output: output + suffix, isError: false };
    } catch (err) {
      return {
        id: '',
        name: this.name,
        output: `Error searching files: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
