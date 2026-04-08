import { fork } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class AgentTool implements Tool {
  readonly name = 'Agent';
  readonly description = 'Spawn an independent subagent with its own context window and tools. Use for parallel research, independent file modifications, or focused subtasks. Each subagent has vault access (Ori memory). Multiple Agent calls in one response run concurrently (up to 5). Model guide: "haiku" for quick searches, "sonnet" for code changes, "opus" for complex analysis, "deepseek"/"local" for bulk/free tasks.';
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
            description: 'Complete description of what the subagent should do. Be specific — it has no context from this conversation.',
          },
          model: {
            type: 'string',
            description: 'Model shortcut for the subagent. E.g. "sonnet", "haiku", "opus", "deepseek", "local". Default: cheap slot.',
          },
          read_only: {
            type: 'boolean',
            description: 'Restrict subagent to read-only tools only. Write/Edit/Bash disabled structurally. Default: false.',
          },
          max_turns: {
            type: 'number',
            description: 'Max agent loop iterations. Default: 20. Lower (5-10) for focused tasks.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the subagent. Default: current directory.',
          },
        },
        required: ['task'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const task = input.task as string;
    const model = (input.model as string) || 'cheap';
    const readOnly = (input.read_only as boolean) || false;
    const maxTurns = (input.max_turns as number) || 20;
    const agentCwd = resolve(ctx.cwd, (input.cwd as string) || '.');

    const childArgs = [task, '--model', model, '--max-turns', String(maxTurns)];
    if (readOnly) childArgs.push('--read-only');

    try {
      const result = await new Promise<string>((resolvePromise, reject) => {
        const child = fork(
          resolve(import.meta.dirname ?? '.', '..', 'index.js'),
          childArgs,
          {
            cwd: agentCwd,
            env: {
              ...process.env,
              ARIES_SUBAGENT: '1',
            },
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            timeout: 300_000,
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
