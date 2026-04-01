import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class GrepTool implements Tool {
  readonly name = 'Grep';
  readonly description = 'Search file contents using ripgrep (rg). Supports regex patterns. Returns matching lines with file paths and line numbers.';
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
            description: 'Regex pattern to search for.',
          },
          path: {
            type: 'string',
            description: 'File or directory to search in. Defaults to working directory.',
          },
          glob: {
            type: 'string',
            description: 'Glob to filter files (e.g., "*.ts", "*.{js,tsx}").',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case insensitive search (default: false).',
          },
          context: {
            type: 'number',
            description: 'Number of context lines before and after each match.',
          },
        },
        required: ['pattern'],
      },
    };
  }

  async execute(input: Record<string, unknown>, ctx: { cwd: string }): Promise<ToolResult> {
    const pattern = input.pattern as string;
    const searchPath = resolve(ctx.cwd, (input.path as string) || '.');
    const fileGlob = input.glob as string | undefined;
    const caseInsensitive = input.case_insensitive as boolean | undefined;
    const context = input.context as number | undefined;

    const args = ['--no-heading', '--line-number', '--color=never', '--max-count=250'];
    if (caseInsensitive) args.push('-i');
    if (context) args.push(`-C${context}`);
    if (fileGlob) args.push('--glob', fileGlob);
    args.push('--', pattern, searchPath);

    return new Promise<ToolResult>((res) => {
      // Try rg first, fall back to grep
      const proc = spawn('rg', args, { cwd: ctx.cwd, timeout: 30_000 });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 1 && !stderr) {
          // rg returns 1 for no matches
          res({ id: '', name: this.name, output: 'No matches found.', isError: false });
        } else if (code === 0) {
          res({ id: '', name: this.name, output: stdout.trim(), isError: false });
        } else {
          res({ id: '', name: this.name, output: stderr || `grep exited with code ${code}`, isError: true });
        }
      });

      proc.on('error', () => {
        // rg not available, fall back to grep
        this.fallbackGrep(pattern, searchPath, ctx.cwd).then(res);
      });
    });
  }

  private async fallbackGrep(pattern: string, searchPath: string, cwd: string): Promise<ToolResult> {
    return new Promise<ToolResult>((res) => {
      const proc = spawn('grep', ['-rn', '--include=*.ts', '--include=*.js', '--include=*.md', pattern, searchPath], {
        cwd,
        timeout: 30_000,
      });

      let stdout = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.on('close', (code) => {
        if (code === 1) {
          res({ id: '', name: this.name, output: 'No matches found.', isError: false });
        } else {
          res({ id: '', name: this.name, output: stdout.trim() || 'No matches found.', isError: false });
        }
      });
      proc.on('error', (err) => {
        res({ id: '', name: this.name, output: `Search failed: ${err.message}`, isError: true });
      });
    });
  }
}
