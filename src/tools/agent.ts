import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class AgentTool implements Tool {
  readonly name = 'Agent';
  readonly description = 'Spawn a subagent to handle a task in an isolated context. The subagent gets its own conversation with a focused prompt. Use for parallel research, independent subtasks, or when you need a fresh context window for a specific problem.';
  readonly readOnly = true; // subagents are isolated, don't affect parent state

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A complete description of what the subagent should do. Be specific — it has no context from this conversation.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the subagent (default: current directory).',
          },
        },
        required: ['task'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const task = input.task as string;
    const agentCwd = resolve(ctx.cwd, (input.cwd as string) || '.');

    try {
      // Spawn as a child process running aries with the task as a prompt
      // Uses --model bulk to route to the cheap/bulk model
      const result = await new Promise<string>((resolvePromise, reject) => {
        const child = fork(
          resolve(import.meta.dirname ?? '.', 'index.js'),
          [task, '--model', 'bulk'],
          {
            cwd: agentCwd,
            env: { ...process.env, ARIES_SUBAGENT: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 300_000, // 5 minute timeout
          },
        );

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        child.on('close', (code) => {
          if (code === 0 || stdout.length > 0) {
            resolvePromise(stdout || '(subagent completed with no output)');
          } else {
            reject(new Error(stderr || `Subagent exited with code ${code}`));
          }
        });

        child.on('error', reject);
      });

      // Truncate long subagent output
      const output = result.length > 10_000
        ? result.slice(0, 10_000) + `\n\n... (${result.length} chars total, truncated)`
        : result;

      return { id: '', name: this.name, output, isError: false };
    } catch (err) {
      return {
        id: '', name: this.name,
        output: `Subagent failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
