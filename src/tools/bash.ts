import { spawn } from 'node:child_process';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class BashTool implements Tool {
  readonly name = 'Bash';
  readonly description = 'Execute a bash command and return its output. Use for system commands, git operations, running tests, installing packages, and any terminal operations.';
  readonly readOnly = false;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute.',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 120000, max: 600000).',
          },
        },
        required: ['command'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const command = input.command as string;
    const timeout = Math.min((input.timeout as number) || 120_000, 600_000);

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
        env: { ...process.env },
        timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        const output = [
          stdout,
          stderr ? `\nSTDERR:\n${stderr}` : '',
          `\nExit code: ${code ?? 'unknown'}`,
        ].join('');

        resolve({
          id: '',
          name: this.name,
          output: output.trim(),
          isError: code !== 0,
        });
      });

      proc.on('error', (err) => {
        resolve({
          id: '',
          name: this.name,
          output: `Failed to execute command: ${err.message}`,
          isError: true,
        });
      });
    });
  }
}
