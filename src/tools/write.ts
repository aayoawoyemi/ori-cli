import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class WriteTool implements Tool {
  readonly name = 'Write';
  readonly description = 'Write content to a file. Creates the file and parent directories if they do not exist. Overwrites existing content.';
  readonly readOnly = false;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Absolute or relative path to write to.',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file.',
          },
        },
        required: ['file_path', 'content'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const filePath = resolve(ctx.cwd, input.file_path as string);
    const content = input.content as string;

    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf-8');
      return {
        id: '',
        name: this.name,
        output: `File written successfully: ${filePath}`,
        isError: false,
      };
    } catch (err) {
      return {
        id: '',
        name: this.name,
        output: `Error writing file: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
