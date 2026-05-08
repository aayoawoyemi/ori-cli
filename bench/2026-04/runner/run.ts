/**
 * Bench runner â€” executes the 10-task suite across aries-cli, claude-code, pi.
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
 *   - aries built locally (we invoke node dist/index.js with ARIES_HEADLESS=1)
 *   - bench/2026-04/fixtures/pi-mono cloned (for tasks 06-10)
 *   - ANTHROPIC_API_KEY set (claude + aries default to Anthropic)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
  failureAttribution?: {
    missing: string[];
    reasons: string[];
    finalAnswerChars: number;
    finalAnswerHead: string;
    finalAnswerTail?: string;
  };
  notes: string;
  exitCode: number | null;
}

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const RUNS_ROOT = join(REPO_ROOT, 'bench', '2026-04', 'runs');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per task
const MODEL = process.env.BENCH_MODEL ?? 'claude-opus-4-7';
const ARIES_MODEL = process.env.BENCH_ARIES_MODEL;

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function ariesExecutable(envOverrides: NodeJS.ProcessEnv = {}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const distEntry = join(REPO_ROOT, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    throw new Error(`aries dist not built. Run \`npm run build\` first. Looked at: ${distEntry}`);
  }
  return {
    cmd: process.execPath, // node
    args: [distEntry],
    env: { ...process.env, ...envOverrides, ARIES_HEADLESS: '1' },
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

function getInvocation(cli: CliName, prompt: string, envOverrides: NodeJS.ProcessEnv = {}): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin?: string; useShell: boolean } {
  if (cli === 'aries-cli') {
    // Spawn node directly; no shell needed even on Windows.
    // Aries reads prompt from process.argv in subagent mode.
    const e = ariesExecutable(envOverrides);
    const modelArgs = ARIES_MODEL ? ['--model', ARIES_MODEL] : [];
    return { ...e, args: [...e.args, ...modelArgs, prompt], useShell: false };
  }
  if (cli === 'claude-code') {
    // claude.cmd shim on Windows requires shell:true. Prompt via stdin to
    // avoid cmd.exe whitespace tokenization.
    const e = claudeExecutable();
    return { ...e, stdin: prompt, useShell: process.platform === 'win32' };
  }
  if (cli === 'pi-coding-agent') {
    // pi.cmd shim on Windows requires shell:true. Pi reads stdin when
    // stdin isn't a TTY (its main.ts mode-detection: `!stdinIsTTY â†’ print`).
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

function execCli(cli: CliName, prompt: string, envOverrides: NodeJS.ProcessEnv = {}): Promise<ExecResult> {
  return new Promise((resolveP, rejectP) => {
    const inv = getInvocation(cli, prompt, envOverrides);
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

// 2026-05-03 â€” for external (pi-mono) tasks running on aries-cli, append a
// reindex hint pointing at the fixture path. Without this, the model's
// codebase.* primitives query the aries-cli index (unrelated repo) and
// return empty, forcing fallback to fs.read+rgrep and burning turns. CC and
// Pi see the unmodified prompt â€” the hint is structurally Aries-specific
// (only Aries has reindex). Companion to the swe-lite run.ts fix from
// earlier today; same root cause (model + workspace + index mismatch),
// same shape of fix.
function maybeAriesReindexHint(task: BenchTask, cli: CliName): string {
  if (cli !== 'aries-cli') return task.prompt;
  if (task.category !== 'external') return task.prompt;
  const fixtureRoot = join(REPO_ROOT, 'bench', '2026-04', 'fixtures', 'pi-mono').replace(/\\/g, '/');
  return [
    task.prompt,
    '',
    `Aries: this question is about a fresh codebase (pi-mono) you have not indexed. In the Python Repl, call \`reindex(${JSON.stringify(fixtureRoot)})\` directly as a namespace function; do not wrap it in shell.run. After reindexing, use absolute fixture paths such as \`${fixtureRoot}/packages/agent/src/agent-loop.ts\` for fs.read/fs.grep if codebase paths do not resolve. Without reindex, codebase.find_symbol / codebase.search / codebase.get_file_summary query the wrong index and return empty.`,
  ].join('\n');
}

async function runOne(task: BenchTask, cli: CliName, runDir: string): Promise<RunResult> {
  console.log(`â–¶ ${task.id} on ${cli}`);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const benchSessionId = cli === 'aries-cli'
    ? `bench-${task.id}-${startMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    : undefined;

  const promptForRun = maybeAriesReindexHint(task, cli);

  let exec: ExecResult;
  let spawnErr: unknown = null;
  try {
    exec = await execCli(cli, promptForRun, benchSessionId ? { ARIES_SESSION_ID: benchSessionId } : {});
  } catch (err) {
    spawnErr = err;
    exec = { stdout: '', stderr: String(err), exitCode: null, wallMs: Date.now() - startMs };
  }

  let metrics: Metrics;
  if (cli === 'aries-cli') {
    metrics = parseAries(exec.stdout, exec.stderr, startMs, benchSessionId);
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
    model: metrics.observedModel ?? (cli === 'aries-cli' ? (ARIES_MODEL ?? 'aries-config-default') : MODEL),
    startedAt,
    wallMs: exec.wallMs,
    metrics,
    fragmentation,
    success: grade.passed,
    successDetails: grade,
    ...(!grade.passed
      ? {
          failureAttribution: {
            missing: grade.missing,
            reasons: grade.reasons,
            finalAnswerChars: metrics.finalAnswer.length,
            finalAnswerHead: metrics.finalAnswer.slice(0, 2000),
            ...(metrics.finalAnswer.length > 2000
              ? { finalAnswerTail: metrics.finalAnswer.slice(-2000) }
              : {}),
          },
        }
      : {}),
    notes: spawnErr ? `spawn error: ${String(spawnErr)}` : (exec.stderr ? `stderr: ${exec.stderr.slice(0, 500)}` : ''),
    exitCode: exec.exitCode,
  };

  // Write per-run JSON + transcript
  const outPath = join(runDir, `${task.id}-${cli}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
  const transcriptPath = join(runDir, `${task.id}-${cli}.transcript.txt`);
  writeFileSync(transcriptPath, metrics.transcript, 'utf-8');

  console.log(
    `  ${result.success ? 'âœ“' : 'âœ—'} ` +
      `tokens=${metrics.tokens.total} (cached=${metrics.tokens.cached}) ` +
      `tools=${metrics.toolCalls.total} ` +
      `wall=${(exec.wallMs / 1000).toFixed(1)}s` +
      (grade.missing.length > 0 ? ` missing=${grade.missing.length}` : ''),
  );

  return result;
}

/**
 * Load all .json result files from runDir and merge with freshResults.
 * freshResults take priority on taskId+cli collisions (latest run wins).
 * This fixes the aggregation bug where running the bench multiple times
 * into the same date dir would overwrite SUMMARY.md with only the last
 * invocation's results.
 */
function loadAndMergeResults(freshResults: RunResult[], runDir: string): RunResult[] {
  const diskResults: RunResult[] = [];
  const files = readdirSync(runDir).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = readFileSync(join(runDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as RunResult;
      // Sanity check: must have taskId and cli fields
      if (parsed.taskId && parsed.cli) {
        diskResults.push(parsed);
      }
    } catch {
      // Skip malformed JSON files
    }
  }

  // Deduplicate: fresh results win over disk results on same taskId+cli key
  const freshKeys = new Set(freshResults.map((r) => `${r.taskId}::${r.cli}`));
  const merged = [...freshResults];
  for (const r of diskResults) {
    const key = `${r.taskId}::${r.cli}`;
    if (!freshKeys.has(key)) {
      merged.push(r);
    }
  }
  return merged;
}

function summarize(results: RunResult[], runDir: string): void {
  // Merge current-run results with all pre-existing .json results in runDir.
  // This ensures multiple partial runs on the same date combine cleanly into
  // one SUMMARY.md. Current-run results win on duplicate taskId+cli pairs.
  const allResults = loadAndMergeResults(results, runDir);
  const byTask: Record<string, RunResult[]> = {};
  for (const r of allResults) {
    (byTask[r.taskId] ??= []).push(r);
  }

  let md = '# bench / 2026-04 â€” run summary\n\n';
  md += `Date: ${todayStamp()}\n`;
  md += `Model: ${MODEL}\n\n`;
  md += `## Matrix\n\n`;
  md += `| task | aries-cli | claude-code | pi-coding-agent |\n`;
  md += `|---|---|---|---|\n`;
  // Build task list: known TASKS first (in canonical order), then any extra
  // task IDs found on disk from older/different task sets, sorted alphabetically.
  const knownIds = new Set(TASKS.map((t) => t.id));
  const extraIds = Object.keys(byTask).filter((id) => !knownIds.has(id)).sort();
  const allTaskIds = [...TASKS.map((t) => t.id), ...extraIds];

  for (const taskId of allTaskIds) {
    const cells = (['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]).map((cli) => {
      const r = byTask[taskId]?.find((x) => x.cli === cli);
      if (!r) return 'â€”';
      const s = r.success ? 'âœ“' : 'âœ—';
      const loop2Cells = r.metrics.loop2?.cells;
      const loop2Thinking = r.metrics.loop2?.thinkingEvents;
      const loop3 = r.metrics.loop3;
      const compose = r.metrics.compose;
      const cellSuffix = loop2Cells !== undefined
        ? `/${loop2Cells}c${loop2Thinking !== undefined ? `/${loop2Thinking}t` : ''}`
        : loop3
          ? `/${loop3.cells}c/${loop3.composedCells}cmp/${loop3.pureProbes}probe${compose ? `/${compose.preflights.coveragePct}%pf/${compose.gateRejections.total}gate` : ''}`
        : '';
      return `${s} ${r.metrics.tokens.total}/${r.metrics.toolCalls.total}${cellSuffix}/${(r.wallMs / 1000).toFixed(0)}s`;
    });
    md += `| ${taskId} | ${cells[0]} | ${cells[1]} | ${cells[2]} |\n`;
  }
  md += `\nLegend: success / total tokens / execution batches-or-tool calls [/ Loop2 cells / Loop2 thinking events OR Loop3 cells / composed cells / inferred probe cells / preflight coverage / gate rejections] / wall seconds\n`;
  md += `Compose aggregates: reqs = total (quick/compose/goal), gates = total (preflight_required/update_required/scout_budget_exceeded), scout/verify/repair = parsed preflight cell kinds, micro by mode = quick/compose/goal/unknown, closure = per (compose+goal) request: %commit(N/total) counts requests with a commit-kind preflight OR an exempt commit-only cell; %done(N/total) counts requests that ended via structured done().\n\n`;

  // Per-CLI aggregates
  md += `## Per-CLI aggregates\n\n`;
  md += `| cli | success rate | mean tokens | mean tool calls/batches | mean Loop2 cells | mean Loop2 thinking events | Loop3 cell comp | Loop3 state reuse | Loop3 probes/run | Loop3 useful ops/cell | Loop3 done path | compose reqs | preflight cov | gates | scout/verify/repair | micro by mode | closure | Loop3 active/idle | mean wall |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const cli of ['aries-cli', 'claude-code', 'pi-coding-agent'] as CliName[]) {
    const rs = allResults.filter((r) => r.cli === cli);
    if (rs.length === 0) continue;
    const successCount = rs.filter((r) => r.success).length;
    const meanTokens = rs.reduce((a, r) => a + r.metrics.tokens.total, 0) / rs.length;
    const meanTools = rs.reduce((a, r) => a + r.metrics.toolCalls.total, 0) / rs.length;
    const loop2Runs = rs.filter((r) => r.metrics.loop2);
    const meanLoop2Cells = loop2Runs.length > 0
      ? loop2Runs.reduce((a, r) => a + (r.metrics.loop2?.cells ?? 0), 0) / loop2Runs.length
      : 0;
    const meanLoop2Thinking = loop2Runs.length > 0
      ? loop2Runs.reduce((a, r) => a + (r.metrics.loop2?.thinkingEvents ?? 0), 0) / loop2Runs.length
      : 0;
    const loop3Runs = rs.filter((r) => r.metrics.loop3);
    const loop3ShapeRecords = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.shapeRecords ?? 0), 0);
    const loop3Composed = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.composedCells ?? 0), 0);
    const loop3Cells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.cells ?? 0), 0);
    const loop3UsefulOps = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.usefulOperations ?? 0), 0);
    const meanLoop3Probes = loop3Runs.length > 0
      ? loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.pureProbes ?? 0), 0) / loop3Runs.length
      : 0;
    const loop3StructuredDone = loop3Runs.filter((r) => r.metrics.loop3?.structuredDone).length;
    const loop3StateReuseCells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.crossCellStateReuseCells ?? 0), 0);
    const loop3StateAvailableCells = loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.cellsWithPriorStateAvailable ?? 0), 0);
    const loop3StateReuseDensity = loop3StateAvailableCells > 0 ? `${Math.round((loop3StateReuseCells / loop3StateAvailableCells) * 100)}%` : '-';
    const loop3CompDensity = loop3ShapeRecords > 0 ? `${Math.round((loop3Composed / loop3ShapeRecords) * 100)}%` : 'â€”';
    const loop3UsefulPerCell = loop3Cells > 0 ? (loop3UsefulOps / loop3Cells).toFixed(2) : 'â€”';
    const loop3DonePath = loop3Runs.length > 0 ? `${loop3StructuredDone}/${loop3Runs.length}` : 'â€”';
    const composeRuns = rs.filter((r) => r.metrics.compose);
    const composeReqs = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.total ?? 0), 0);
    const composeQuick = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.quick ?? 0), 0);
    const composeModeReqs = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.compose ?? 0), 0);
    const composeGoal = composeRuns.reduce((a, r) => a + (r.metrics.compose?.requests.goal ?? 0), 0);
    const composeCells = composeRuns.reduce((a, r) => a + (r.metrics.compose?.cells.total ?? 0), 0);
    const composeGates = composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.total ?? 0), 0);
    const composePreflights = composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.parsed ?? 0), 0);
    const composeCoverageDenom = composeCells + composeGates;
    const composeCoverage = composeCoverageDenom > 0 ? `${Math.round((composePreflights / composeCoverageDenom) * 100)}%` : 'â€”';
    const composeGateBreakdown = composeRuns.length > 0
      ? `${composeGates} (${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.preflightRequired ?? 0), 0)}pf/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.updateRequired ?? 0), 0)}upd/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.gateRejections.scoutBudgetExceeded ?? 0), 0)}scout)`
      : 'â€”';
    const composeKinds = composeRuns.length > 0
      ? `${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.scout ?? 0), 0)}/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.verify ?? 0), 0)}/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.preflights.repair ?? 0), 0)}`
      : 'â€”';
    const composeReqSummary = composeRuns.length > 0
      ? `${composeReqs} (${composeQuick}q/${composeModeReqs}c/${composeGoal}g)`
      : 'â€”';
    const microByMode = composeRuns.length > 0
      ? `${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.quick ?? 0), 0)}q/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.compose ?? 0), 0)}c/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.goal ?? 0), 0)}g/${composeRuns.reduce((a, r) => a + (r.metrics.compose?.microCellsByMode.unknown ?? 0), 0)}?`
      : 'â€”';
    // Closure aggregates from per-request closure tracking (parsers.ts). The
    // denominator is compose+goal requests across all runs — quick mode has
    // no closure expectation, so excluding it keeps the rate honest.
    // commitsCount counts requests that had EITHER a commit-kind preflight
    // OR an exempt commit-only cell (V2 — done(answer) without preflight).
    // donesCount counts requests that ended with a structured done(...).
    const composeOrGoalReqsTotal = composeRuns.reduce((a, r) => a + (r.metrics.compose?.closure.composeOrGoalRequests ?? 0), 0);
    const composeCommitsCount = composeRuns.reduce((a, r) => a + (r.metrics.compose?.closure.commitsCount ?? 0), 0);
    const composeDonesCount = composeRuns.reduce((a, r) => a + (r.metrics.compose?.closure.donesCount ?? 0), 0);
    const composeClosure = composeRuns.length > 0
      ? `${composeOrGoalReqsTotal > 0 ? Math.round((composeCommitsCount / composeOrGoalReqsTotal) * 100) : 0}%commit(${composeCommitsCount}/${composeOrGoalReqsTotal})/${composeOrGoalReqsTotal > 0 ? Math.round((composeDonesCount / composeOrGoalReqsTotal) * 100) : 0}%done(${composeDonesCount}/${composeOrGoalReqsTotal})`
      : 'â€”';
    const loop3ActiveIdle = loop3Runs.length > 0
      ? `${(loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.activeElapsedMs ?? 0), 0) / 1000).toFixed(1)}s/${(loop3Runs.reduce((a, r) => a + (r.metrics.loop3?.idleMs ?? 0), 0) / 1000).toFixed(1)}s`
      : 'â€”';
    const meanWall = rs.reduce((a, r) => a + r.wallMs, 0) / rs.length / 1000;
    md += `| ${cli} | ${successCount}/${rs.length} | ${meanTokens.toFixed(0)} | ${meanTools.toFixed(1)} | ${loop2Runs.length > 0 ? meanLoop2Cells.toFixed(1) : 'â€”'} | ${loop2Runs.length > 0 ? meanLoop2Thinking.toFixed(1) : 'â€”'} | ${loop3CompDensity} | ${loop3StateReuseDensity} | ${loop3Runs.length > 0 ? meanLoop3Probes.toFixed(1) : 'â€”'} | ${loop3UsefulPerCell} | ${loop3DonePath} | ${composeReqSummary} | ${composeCoverage} | ${composeGateBreakdown} | ${composeKinds} | ${microByMode} | ${composeClosure} | ${loop3ActiveIdle} | ${meanWall.toFixed(1)}s |\n`;
  }

  writeFileSync(join(runDir, 'SUMMARY.md'), md, 'utf-8');
  console.log(`\nSummary: ${join(runDir, 'SUMMARY.md')}`);
}

function loadOAuthTokenIfMissing(): void {
  // Pi uses --api-key explicitly when ANTHROPIC_API_KEY is set (see piExecutable).
  // Aries reads its OAuth credentials from disk via src/auth/anthropicLocalOAuth.ts.
  // CC reads ~/.claude/.credentials.json natively. So no env-var loading is needed
  // here â€” each CLI handles auth via its own path. Function kept as a no-op for
  // future re-enablement if we want to force OAuth on pi once the body issue is
  // diagnosed and pi can route to subscription cleanly.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('(ANTHROPIC_API_KEY not set â€” pi will fall back to OAuth from disk, which currently triggers "out of extra usage" billing rejection)');
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
