import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class ReadTool implements Tool {
  readonly name = 'Read';
  readonly description = 'Read a file from the filesystem. Returns the file contents with line numbers. Use offset and limit for large files.';
  readonly readOnly = true;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or relative path to the file to read.',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (0-based). Optional.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read. Optional, defaults to 2000.',
          },
        },
        required: ['file_path'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, input.file_path as string);
    const offset = (input.offset as number) || 0;
    const limit = (input.limit as number) || 2000;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const slice = lines.slice(offset, offset + limit);
      const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');

      const output = slice.length < lines.length
        ? `${numbered}\n\n(Showing lines ${offset + 1}-${offset + slice.length} of ${lines.length})`
        : numbered;

      return { id: '', name: this.name, output, isError: false };
    } catch (err) {
      return {
        id: '',
        name: this.name,
        output: `Error reading file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
