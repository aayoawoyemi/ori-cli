import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

// ── Constrained Bash ─────────────────────────────────────────────────────────
// Whitelist: build/test, git, system ops, package management.
// Blocked patterns are split into categories based on REPL availability.

const ALLOWED_PREFIXES = new Set([
  // Build/test
  'tsc', 'npx', 'npm', 'node', 'bun', 'pnpm', 'yarn',
  // Git
  'git',
  // Python
  'python', 'pip', 'uv',
  // Directory/file management
  'dir', 'ls', 'mkdir', 'rm', 'del', 'cp', 'copy', 'mv', 'move', 'touch',
  // Environment
  'env', 'set', 'echo', 'printenv', 'which', 'where',
  // Editor/tools
  'code', 'cursor', 'ori',
  // System
  'powershell', 'cmd', 'docker', 'chmod', 'chown',
  // File reading — allowed when REPL is off (non-Claude models need these)
  'cat', 'head', 'tail', 'less', 'more', 'bat',
  // File searching — allowed when REPL is off
  'grep', 'rg', 'find', 'fd', 'ag', 'ack',
]);

// Always blocked — these have dedicated tools regardless of mode
const ALWAYS_BLOCKED = [
  /^sed\s/,   // use Edit tool
  /^awk\s/,   // use Edit tool
  /^tee\s/,   // use Write tool
  /[^|]>\s/,  // redirects that write files — use Write tool
  />>/,       // append redirects — use Write tool
  /\beval\b/, // never
];

// Only blocked when REPL is available — model should use codebase.* instead
const REPL_MODE_BLOCKED = [
  /^cat\s/, /^head\s/, /^tail\s/, /^less\s/, /^more\s/, /^bat\s/,
  /^grep\s/, /^rg\s/, /^find\s/, /^fd\s/, /^ag\s/, /^ack\s/,
  /^ls\b/, /^dir\b/,                                     // codebase.list_files()
  /^powershell\b/, /^cmd\b/,                              // escape hatches
  /^code\b/, /^cursor\b/,                                 // no editor launching
];

// Always blocked — use WebFetch/WebSearch instead
const WEB_BLOCKED = [
  /^curl\s/, /^wget\s/, /^http\s/,
];

function isCommandAllowed(command: string, replEnabled: boolean): { allowed: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: 'empty command' };

  // Always-blocked patterns (highest priority)
  for (const pattern of ALWAYS_BLOCKED) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Blocked: "${trimmed.split(' ')[0]}" — use the Edit or Write tool instead.`,
      };
    }
  }

  // REPL-mode-only blocks: when REPL is on, push code exploration through codebase.*
  if (replEnabled) {
    for (const pattern of REPL_MODE_BLOCKED) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: `Blocked: "${trimmed.split(' ')[0]}" duplicates REPL capabilities. Use the Repl tool with codebase.search(), codebase.get_context(), or vault.* instead.`,
        };
      }
    }
  }

  // Web blocks — always on (WebFetch is always available)
  for (const pattern of WEB_BLOCKED) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Blocked: "${trimmed.split(' ')[0]}" — use WebFetch or WebSearch instead.`,
      };
    }
  }

  // Check if first token is whitelisted
  const firstToken = trimmed.split(/\s/)[0]!.toLowerCase();
  // Handle paths (e.g., ./node_modules/.bin/tsc)
  const basename = firstToken.split(/[/\\]/).pop()!;

  if (ALLOWED_PREFIXES.has(basename)) {
    return { allowed: true };
  }

  // Allow piped commands if the first command is allowed
  if (trimmed.includes('|')) {
    const firstCmd = trimmed.split('|')[0]!.trim();
    return isCommandAllowed(firstCmd, replEnabled);
  }

  // Allow && / || chained commands if first is allowed
  if (trimmed.includes('&&') || trimmed.includes('||')) {
    const firstCmd = trimmed.split(/&&|\|\|/)[0]!.trim();
    return isCommandAllowed(firstCmd, replEnabled);
  }

  return {
    allowed: false,
    reason: `Command "${basename}" is not in the allowed list. Bash is constrained to: build/test (tsc, npm, npx), git, file management (mkdir, rm, cp, mv), and system ops.${replEnabled ? ' Use the Repl tool for code exploration and search.' : ''}`,
  };
}

export interface BashToolOptions {
  replEnabled?: boolean;
}

export class BashTool implements Tool {
  readonly name = 'Bash';
  readonly description: string;
  readonly readOnly = false;
  private replEnabled: boolean;

  constructor(options?: BashToolOptions) {
    this.replEnabled = options?.replEnabled ?? false;
    this.description = this.replEnabled
      ? 'Execute system commands. Constrained to: build/test (tsc, npm, npx, node), git, file management (mkdir, rm, cp, mv), environment (env, echo), and tools (docker, ori). Use Repl for code search/reading.'
      : 'Execute system commands including file reading (cat, grep, find), build/test (tsc, npm, npx, node), git, file management (mkdir, rm, cp, mv), environment (env, echo), and tools (docker, ori).';
  }

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: this.replEnabled
              ? 'The command to execute. Allowed: build/test, git, file management, env. Blocked: cat, grep, find, curl (use Repl/WebFetch instead).'
              : 'The command to execute. Allowed: build/test, git, file management, env, cat, grep, find. Blocked: sed, awk, curl (use Edit/WebFetch instead).',
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
    // Sanitize curly quotes from Windows terminals (ConPTY)
    const command = (input.command as string)
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    const timeout = Math.min((input.timeout as number) || 120_000, 600_000);

    // Constraint check
    const check = isCommandAllowed(command, this.replEnabled);
    if (!check.allowed) {
      return {
        id: '',
        name: this.name,
        output: check.reason!,
        isError: true,
      };
    }

    // Platform-aware shell selection
    const isWindows = platform() === 'win32';
    const shell = isWindows ? 'cmd.exe' : 'bash';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    return new Promise<ToolResult>((resolve) => {
      const proc = spawn(shell, shellArgs, {
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
