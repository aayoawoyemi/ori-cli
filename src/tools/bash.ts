import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';
import type { ReplHandle } from '../repl/setup.js';

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
  // Environment / navigation
  'cd', 'env', 'set', 'echo', 'printenv', 'which', 'where',
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
  // ls/dir are NOT blocked — codebase.list_files() is a poor substitute
  // for actual filesystem navigation (especially outside the project).
  /^cmd\b/,                                                // cmd blocked; powershell allowed
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
          reason: `Blocked: "${trimmed.split(' ')[0]}" — use Repl instead. fs.listdir(path) for directory listing, fs.glob(pattern, path) for file search, fs.read(path) for file contents, codebase.search(query) for code search (project-scoped only).`,
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

// ── Soft rewrite: map navigation shell commands → REPL equivalents ───────────

interface ReplRewrite {
  code: string;
  label: string;
}

function tryRewriteAsRepl(command: string, cwd: string): ReplRewrite | null {
  const cmd = command.trim();

  // cat <path> [| head -N]
  const catHead = cmd.match(/^cat\s+["']?([^\s|"']+)["']?\s*\|\s*head\s+-(\d+)$/);
  if (catHead) {
    const [, path, n] = catHead;
    return { code: `print(fs.read(${JSON.stringify(path)}, offset=0, limit=${n}))`, label: `fs.read("${path}", limit=${n})` };
  }
  const catTail = cmd.match(/^cat\s+["']?([^\s|"']+)["']?\s*\|\s*tail\s+-(\d+)$/);
  if (catTail) {
    const [, path, n] = catTail;
    return { code: `content = fs.read(${JSON.stringify(path)})\nlines = content.split('\\n')\nprint('\\n'.join(lines[-${n}:]))`, label: `fs.read("${path}") tail ${n}` };
  }
  const catSimple = cmd.match(/^cat\s+["']?([^\s"']+)["']?$/);
  if (catSimple) {
    const [, path] = catSimple;
    return { code: `print(fs.read(${JSON.stringify(path)}))`, label: `fs.read("${path}")` };
  }

  // head -N <path>
  const headFile = cmd.match(/^head\s+-(\d+)\s+["']?([^\s"']+)["']?$/);
  if (headFile) {
    const [, n, path] = headFile;
    return { code: `print(fs.read(${JSON.stringify(path)}, offset=0, limit=${n}))`, label: `fs.read("${path}", limit=${n})` };
  }

  // grep [-flags] "pattern" [path]  — no pipes to write commands
  if (/^grep\b/.test(cmd) && !/\|\s*(sed|awk|tee|xargs|write|cat\s*>)/.test(cmd)) {
    const grepMatch = cmd.match(/^grep\s+(?:-[a-zA-Z]+\s+)*["']?([^"'\s]+)["']?(?:\s+(.+))?$/);
    if (grepMatch) {
      const [, pattern] = grepMatch;
      return { code: `results = codebase.search(${JSON.stringify(pattern)}, limit=20)\nfor r in results:\n    print(r['file'] + ':' + str(r['line']) + ': ' + r['snippet'])`, label: `codebase.search("${pattern}")` };
    }
  }

  // find <path> -type d → fs.listdir filtered to directories
  const findTypeD = cmd.match(/^find\s+["']?([^\s"']+)["']?\s+-type\s+d/);
  if (findTypeD) {
    const [, path] = findTypeD;
    return { code: `entries = fs.listdir(${JSON.stringify(path)})\nprint('\\n'.join(e for e in entries if e.endswith('/')))`, label: `fs.listdir("${path}") dirs only` };
  }

  // find <path> -name "pattern" → fs.glob
  const findName = cmd.match(/^find\s+["']?([^\s"']+)["']?\s+-name\s+["']?([^\s"']+)["']?/);
  if (findName) {
    const [, findPath, pattern] = findName;
    const globPattern = (pattern ?? '').replace(/^["']|["']$/g, '');
    return { code: `print('\\n'.join(fs.glob(${JSON.stringify(globPattern)}, ${JSON.stringify(findPath)})))`, label: `fs.glob("${globPattern}", "${findPath}")` };
  }

  // ls / dir — rewrite bare commands to fs.listdir (works on any directory)
  if (/^ls\s*$/.test(cmd)) {
    return { code: `print('\\n'.join(fs.listdir('.')))`, label: 'fs.listdir(".")' };
  }
  if (/^dir\s*$/.test(cmd)) {
    return { code: `print('\\n'.join(fs.listdir('.')))`, label: 'fs.listdir(".")' };
  }

  // wc -l <path>
  const wcLine = cmd.match(/^wc\s+-l\s+["']?([^\s"']+)["']?$/);
  if (wcLine) {
    const [, path] = wcLine;
    return { code: `content = fs.read(${JSON.stringify(path)})\nprint(len(content.split('\\n')))`, label: `line count "${path}"` };
  }

  return null;
}

export interface BashToolOptions {
  replEnabled?: boolean;
  getHandle?: () => ReplHandle | null;
}

export class BashTool implements Tool {
  readonly name = 'Bash';
  readonly description: string;
  readonly readOnly = false;
  private replEnabled: boolean;
  private getHandle: (() => ReplHandle | null) | undefined;

  constructor(options?: BashToolOptions) {
    this.replEnabled = options?.replEnabled ?? false;
    this.getHandle = options?.getHandle;
    this.description = this.replEnabled
      ? 'Execute shell commands for building, testing, and running code. Use for: npm, tsc, node, git, docker, make, mkdir, rm, cp, mv. NOT for reading files, searching code, or listing directories — use Repl for all of that.'
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

  async execute(input: Record<string, unknown>, ctx: { cwd: string; signal?: AbortSignal }): Promise<ToolResult> {
    // Sanitize curly quotes from Windows terminals (ConPTY)
    const command = (input.command as string)
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'");
    const timeout = Math.min((input.timeout as number) || 120_000, 600_000);

    // ── Soft rewrite layer: intercept navigation commands → REPL ─────
    // Instead of returning a block error (wasting a turn), silently execute
    // the equivalent REPL operation and annotate the result so the model
    // learns the mapping in-context.
    if (this.replEnabled && this.getHandle) {
      const rewrite = tryRewriteAsRepl(command, ctx.cwd);
      if (rewrite) {
        const handle = this.getHandle();
        if (handle) {
          const result = await handle.exec({ code: rewrite.code }, ctx.signal);
          const output = [
            result.stdout?.trimEnd() ?? '',
            result.stderr ? `[stderr]\n${result.stderr.trimEnd()}` : '',
            result.exception ? `[exception]\n${result.exception.trimEnd()}` : '',
          ].filter(Boolean).join('\n');
          return {
            id: '',
            name: this.name,
            output: `[Routed via Repl: ${rewrite.label}]\n${output || '(no output)'}`,
            isError: !!result.exception,
          };
        }
      }
    }

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
