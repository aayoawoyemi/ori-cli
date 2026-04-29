/**
 * Bench runner — executes the 10-task suite across aries-cli, claude-code, pi.
 *
 * Usage:
 *   npx tsx bench/2026-04/runner/run.ts                           # all tasks, all CLIs
 *   npx tsx bench/2026-04/runner/run.ts --task 01-cache-break-trace
 *   npx tsx bench/2026-04/runner/run.ts --cli aries-cli           # just one CLI
 *   npx tsx bench/2026-04/runner/run.ts --task 01-... --cli aries-cli  # one cell
 *
 * Output:
 *   bench/2026-04/runs/{date}/{taskId}-{cli}.json
 *   bench/2026-04/runs/{date}/SUMMARY.md
 *
 * Pre-reqs:
 *   - claude (Claude Code CLI) on PATH
 *   - pi (pi-coding-agent CLI) on PATH, OR set PI_CLI env to its path
 *   - aries built locally (we invoke node dist/index.js with ARIES_SUBAGENT=1)
 *   - bench/2026-04/fixtures/pi-mono cloned (for tasks 06-10)
 *   - ANTHROPIC_API_KEY set (claude + aries default to Anthropic)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS, gradeAnswer, type BenchTask } from './tasks.js';
import { parseAries, parseClaude, parsePi, type Metrics } from './parsers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type CliName = 'aries-cli' | 'claude-code' | 'pi-coding-agent';

interface RunResult {
  taskId: string;
  cli: CliName;
  model: string;
  startedAt: string;
  wallMs: number;
  metrics: Metrics;
  fragmentation: {
    targetToolCalls: number;
    actualToolCalls: number;
    ratio: number;
  };
  success: boolean;
  successDetails: { missing: string[]; reasons: string[] };
  notes: string;
  exitCode: number | null;
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const RUNS_ROOT = join(REPO_ROOT, 'bench', '2026-04', 'runs');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per task
const MODEL = process.env.BENCH_MODEL ?? 'claude-opus-4-7';

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function ariesExecutable(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const distEntry = join(REPO_ROOT, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    throw new Error(`aries dist not built. Run \`npm run build\` first. Looked at: ${distEntry}`);
  }
  return {
    cmd: process.execPath, // node
    args: [distEntry],
    env: { ...process.env, ARIES_SUBAGENT: '1' },
  };
}

function claudeExecutable(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    cmd: 'claude',
    args: [
      '-p',
      '--verbose',                       // required when output-format=stream-json
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--model', MODEL,
    ],
    env: { ...process.env },
  };
}

function piExecutable(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const cli = process.env.PI_CLI ?? 'pi';
  // When ANTHROPIC_API_KEY is set, pass it explicitly via --api-key so pi
  // doesn't fall back to OAuth from the local credentials file. Pi has its
  // own OAuth flow that reads ~/.claude/.credentials.json directly, and the
  // OAuth path currently triggers "out of extra usage" rejections from
  // Anthropic's unified-overage system regardless of billing-header tweaks.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const args = ['--mode', 'json', '--model', `anthropic/${MODEL}`, '--thinking', 'off'];
  if (apiKey) {
    args.push('--api-key', apiKey);
  }
  return {
    cmd: cli,
    args,
    env: { ...process.env },
  };
}

function getInvocation(cli: CliName, prompt: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin?: string; useShell: boolean } {
  if (cli === 'aries-cli') {
    // Spawn node directly; no shell needed even on Windows.
    // Aries reads prompt from process.argv in subagent mode.
    const e = ariesExecutable();
    return { ...e, args: [...e.args, prompt], useShell: false };
  }
  if (cli === 'claude-code') {
    // claude.cmd shim on Windows requires shell:true. Prompt via stdin to
    // avoid cmd.exe whitespace tokenization.
    const e = claudeExecutable();
    return { ...e, stdin: prompt, useShell: process.platform === 'win32' };
  }
  if (cli === 'pi-coding-agent') {
    // pi.cmd shim on Windows requires shell:true. Pi reads stdin when
    // stdin isn't a TTY (its main.ts mode-detection: `!stdinIsTTY → print`).
    const e = piExecutable();
    return { ...e, stdin: prompt, useShell: process.platform === 'win32' };
  }
  throw new Error(`unknown cli: ${cli}`);
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  wallMs: number;
}

function execCli(cli: CliName, prompt: string): Promise<ExecResult> {
  return new Promise((resolveP, rejectP) => {
    const inv = getInvocation(cli, prompt);
    const startMs = Date.now();
    // shell:true is per-CLI (set in getInvocation). aries is always shell:false
    // (we spawn node directly). claude/pi need shell:true on Windows for .cmd shims.
    const child = spawn(inv.cmd, inv.args, { env: inv.env, shell: inv.useShell });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    if (inv.stdin) {
      child.stdin.write(inv.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(killer);
      resolveP({ stdout, stderr, exitCode: code, wallMs: Date.now() - startMs });
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      rejectP(err);
    });
  });
}

async function runOne(task: BenchTask, cli: CliName, runDir: string): Promise<RunResult> {
  console.log(`▶ ${task.id} on ${cli}`);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  let exec: ExecResult;
  let spawnErr: unknown = null;
  try {
    exec = await execCli(cli, task.prompt);
  } catch (err) {
    spawnErr = err;
    exec = { stdout: '', stderr: String(err), exitCode: null, wallMs: Date.now() - startMs };
  }

  let metrics: Metrics;
  if (cli === 'aries-cli') {
    metrics = parseAries(exec.stdout, exec.stderr, startMs);
  } else if (cli === 'claude-code') {
    metrics = parseClaude(exec.stdout);
  } else {
    metrics = parsePi(exec.stdout);
  }

  const grade = spawnErr
    ? { passed: false, missing: [`spawn error: ${String(spawnErr)}`], reasons: [] }
    : gradeAnswer(task.grader, metrics.finalAnswer);

  const fragmentation = {
    targetToolCalls: task.target.toolCalls,
    actualToolCalls: metrics.toolCalls.total,
    ratio: task.target.toolCalls > 0 ? metrics.toolCalls.total / task.target.toolCalls : 0,
  };

  const result: RunResult = {
    taskId: task.id,
    cli,
    model: MODEL,
    startedAt,
    wallMs: exec.wallMs,
    metrics,
    fragmentation,
    success: grade.passed,
    successDetails: grade,
    notes: spawnErr ? `spawn error: ${String(spawnErr)}` : (exec.stderr ? `stderr: ${exec.stderr.slice(0, 500)}` : ''),
    exitCode: exec.exitCode,
  };

  // Write per-run JSON + transcript
  const outPath = join(runDir, `${task.id}-${cli}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  const transcriptPath = join(runDir, `${task.id}-${cli}.transcript.txt`);
  writeFileSync(transcriptPath, metrics.transcript, 'utf-8');

  console.log(
    `  ${result.success ? '✓' : '✗'} ` +
      `tokens=${metrics.tokens.total} (cached=${metrics.tokens.cached}) ` +
      `tools=${metrics.toolCalls.total} ` +
      `wall=${(exec.wallMs / 1000).toFixed(1)}s` +
      (grade.missing.length > 0 ? ` missing=${grade.missing.length}` : ''),
  );

  return result;
}

function summarize(results: RunResult[], runDir: string): void {
  const byTask: Record<string, RunResult[]> = {};
  for (const r of results) {
    (byTask[r.taskId] ??= []).push(r);
  }

  let md = '# bench / 2026-04 — run summary\n\n';
  md += `Date: ${todayStamp()}\n`;
  md += `Model: ${MODEL}\n\n`;
  md += `## Matrix\n\n`;
  md += `| task | aries-cli | claude-code | pi-coding-agent |\n`;
  md += `|---|---|---|---|\n`;
  for (const task of TASKS) {
    const cells = (['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]).map((cli) => {
      const r = byTask[task.id]?.find((x) => x.cli === cli);
      if (!r) return '—';
      const s = r.success ? '✓' : '✗';
      return `${s} ${r.metrics.tokens.total}/${r.metrics.toolCalls.total}/${(r.wallMs / 1000).toFixed(0)}s`;
    });
    md += `| ${task.id} | ${cells[0]} | ${cells[1]} | ${cells[2]} |\n`;
  }
  md += `\nLegend: success / total tokens / tool calls / wall seconds\n\n`;

  // Per-CLI aggregates
  md += `## Per-CLI aggregates\n\n`;
  md += `| cli | success rate | mean tokens | mean tool calls | mean wall |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const cli of ['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]) {
    const rs = results.filter((r) => r.cli === cli);
    if (rs.length === 0) continue;
    const successCount = rs.filter((r) => r.success).length;
    const meanTokens = rs.reduce((a, r) => a + r.metrics.tokens.total, 0) / rs.length;
    const meanTools = rs.reduce((a, r) => a + r.metrics.toolCalls.total, 0) / rs.length;
    const meanWall = rs.reduce((a, r) => a + r.wallMs, 0) / rs.length / 1000;
    md += `| ${cli} | ${successCount}/${rs.length} | ${meanTokens.toFixed(0)} | ${meanTools.toFixed(1)} | ${meanWall.toFixed(1)}s |\n`;
  }

  writeFileSync(join(runDir, 'SUMMARY.md'), md, 'utf-8');
  console.log(`\nSummary: ${join(runDir, 'SUMMARY.md')}`);
}

function loadOAuthTokenIfMissing(): void {
  // Pi uses --api-key explicitly when ANTHROPIC_API_KEY is set (see piExecutable).
  // Aries reads its OAuth credentials from disk via src/auth/anthropicLocalOAuth.ts.
  // CC reads ~/.claude/.credentials.json natively. So no env-var loading is needed
  // here — each CLI handles auth via its own path. Function kept as a no-op for
  // future re-enablement if we want to force OAuth on pi once the body issue is
  // diagnosed and pi can route to subscription cleanly.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('(ANTHROPIC_API_KEY not set — pi will fall back to OAuth from disk, which currently triggers "out of extra usage" billing rejection)');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const taskFilter = args.includes('--task') ? args[args.indexOf('--task') + 1] : null;
  const cliFilter = args.includes('--cli') ? (args[args.indexOf('--cli') + 1] as CliName) : null;

  loadOAuthTokenIfMissing();

  const tasks = taskFilter ? TASKS.filter((t) => t.id === taskFilter) : TASKS;
  const skipPi = args.includes('--skip-pi');
  const defaultClis: CliName[] = skipPi
    ? ['aries-cli', 'claude-code']
    : ['aries-cli', 'claude-code', 'pi-coding-agent'];
  const clis: CliName[] = cliFilter ? [cliFilter] : defaultClis;

  if (tasks.length === 0) {
    console.error(`No task matches "${taskFilter}". Available: ${TASKS.map((t) => t.id).join(', ')}`);
    process.exit(1);
  }

  const runDir = join(RUNS_ROOT, todayStamp());
  mkdirSync(runDir, { recursive: true });
  console.log(`Run directory: ${runDir}\n`);

  const results: RunResult[] = [];
  for (const task of tasks) {
    for (const cli of clis) {
      const r = await runOne(task, cli, runDir);
      results.push(r);
    }
  }

  summarize(results, runDir);
}

main().catch((err) => {
  console.error('Bench failed:', err);
  process.exit(1);
});
