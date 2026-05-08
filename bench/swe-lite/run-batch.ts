/**
 * Batch wrapper around bench/swe-lite/run.ts. Runs a fixed list of tasks
 * across a fixed list of CLIs, reusing existing workspaces (--skip-setup)
 * and resetting the repo to the [bench] apply test_patch commit between
 * runs so each agent starts from clean state.
 *
 * Goal: tight A/B vs the 2026-04-27 baseline triplet on the same task IDs.
 *
 * Usage: npx tsx bench/swe-lite/run-batch.ts
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

// 12-task expansion across 4 repos for the n>=12 paper-readiness pass
// (2026-05-08, late PM). Mix of post-fix re-runs (3362, 5859, 7220) for
// direct prose-vs-XML format deltas and fresh tasks for the broader n.
// Catalog actually has marshmallow + click only as skeleton entries
// (0 tasks each in tasks.json) so this set sticks to the 4 repos with
// real SWE-Bench-Lite tasks AND existing or cheaply-creatable workspaces:
//   psf/requests, pylint-dev/pylint, pytest-dev/pytest, pallets/flask.
// sphinx-doc/sphinx is intentionally deferred — its 2023-vintage setup
// adds ~10min per fresh task and bloats batch wall to >3hrs.
const TASKS = [
  // psf/requests — 4 tasks
  'psf__requests-3362',     // re-run, post-fix (was prose-format failure)
  'psf__requests-2674',     // 12 FTP tests — heavier signal
  'psf__requests-1963',     // 7 FTP
  'psf__requests-863',      // 4 FTP
  // pylint-dev/pylint — 3 tasks
  'pylint-dev__pylint-5859', // re-run, prior pass
  'pylint-dev__pylint-7114', // 1 FTP, fresh
  'pylint-dev__pylint-6506', // 2 FTP, fresh
  // pytest-dev/pytest — 4 tasks
  'pytest-dev__pytest-7220', // re-run, prior pass
  'pytest-dev__pytest-5221', // 2 FTP, smallest problem statement
  'pytest-dev__pytest-5495', // 2 FTP
  'pytest-dev__pytest-7432', // 1 FTP
  // pallets/flask — 1 task
  'pallets__flask-4045',     // 2 FTP, smallest flask problem
];
const CLIS: ('aries-cli' | 'claude-code')[] = ['aries-cli', 'claude-code'];

function newestWorkspace(taskId: string): string | null {
  const parent = join(__dirname, 'workspaces', taskId);
  if (!existsSync(parent)) return null;
  const entries = readdirSync(parent)
    .map((name) => ({ name, mtime: statSync(join(parent, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries.length > 0 ? join(parent, entries[0]!.name) : null;
}

function resetRepo(repoDir: string): void {
  // Hard reset to [bench] apply test_patch HEAD, then nuke any untracked
  // files the previous agent might have created. -e excludes the venv from
  // accidental wipe (venv lives at the workspace root, not inside repo/, so
  // git clean inside repo/ won't touch it — but be paranoid anyway).
  spawnSync('git', ['-C', repoDir, 'reset', '--hard', 'HEAD'], { stdio: 'inherit' });
  spawnSync('git', ['-C', repoDir, 'clean', '-fd'], { stdio: 'inherit' });
}

function runOne(task: string, cli: string, skipSetup: boolean): { ok: boolean; wallS: number } {
  const t0 = Date.now();
  const opts: SpawnSyncOptions = {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  };
  // Only pass --skip-setup when a workspace already exists. For fresh tasks
  // run.ts must do the full clone + venv + install; --skip-setup with no
  // existing workspace would silently use an empty timestamped dir and the
  // agent would fail to find any source to read.
  const args = [
    'tsx', 'bench/swe-lite/run.ts',
    '--task', task,
    '--cli', cli,
  ];
  if (skipSetup) args.push('--skip-setup');
  const r = spawnSync('npx', args, opts);
  const wallS = (Date.now() - t0) / 1000;
  return { ok: r.status === 0, wallS };
}

interface RunRecord {
  task: string;
  cli: string;
  wrapperWallS: number;
  success?: boolean;
  ftpPassed?: number;
  ftpTotal?: number;
  agentWallS?: number;
  stdoutBytes?: number;
}

function readResult(task: string, cli: string): Partial<RunRecord> {
  const path = join(__dirname, 'results', `${task}-${cli}.json`);
  if (!existsSync(path)) return {};
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    return {
      success: r.success,
      ftpPassed: r.fail_to_pass?.passed,
      ftpTotal: r.fail_to_pass?.selectable,
      agentWallS: (r.agent?.wallMs ?? 0) / 1000,
      stdoutBytes: r.agent?.stdoutBytes,
    };
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const records: RunRecord[] = [];
  for (const task of TASKS) {
    const ws = newestWorkspace(task);
    if (!ws) {
      console.error(`!! no workspace for ${task} — run.ts will create one (slow path)`);
    }
    for (const cli of CLIS) {
      console.log(`\n========== ${task} :: ${cli} ==========`);
      // Re-check workspace each iteration. The first CLI on a fresh task
      // creates the workspace; the second CLI then sees it and can skip
      // setup. resetRepo only runs when ws exists (otherwise nothing to reset).
      const liveWs = newestWorkspace(task);
      if (liveWs) {
        const repoDir = join(liveWs, 'repo');
        if (existsSync(repoDir)) resetRepo(repoDir);
      }
      const { ok, wallS } = runOne(task, cli, /* skipSetup */ liveWs !== null);
      const result = readResult(task, cli);
      records.push({ task, cli, wrapperWallS: wallS, ...result });
      console.log(`-- finished ${task}/${cli}: exit=${ok ? 0 : 'fail'} wrapperWall=${wallS.toFixed(1)}s success=${result.success ?? '?'}`);
    }
  }

  console.log('\n\n================ BATCH SUMMARY ================');
  for (const r of records) {
    const status = r.success === true ? 'OK ' : r.success === false ? 'FAIL' : ' ?  ';
    const ftp = r.ftpPassed != null ? `${r.ftpPassed}/${r.ftpTotal}` : '-';
    const agent = r.agentWallS != null ? `${r.agentWallS.toFixed(0)}s` : '-';
    const bytes = r.stdoutBytes != null ? `${(r.stdoutBytes / 1024).toFixed(0)}KB` : '-';
    console.log(`${status}  ${r.task.padEnd(28)}  ${r.cli.padEnd(12)}  ftp=${ftp.padEnd(5)}  agent=${agent.padEnd(6)}  stdout=${bytes}`);
  }
  const totalWall = records.reduce((a, r) => a + r.wrapperWallS, 0);
  console.log(`\ntotal wrapper wall: ${(totalWall / 60).toFixed(1)} min`);
  console.log(`results in: bench/swe-lite/results/`);

  // Regenerate SUMMARY.md from all on-disk results so the rollup reflects
  // the batch we just finished plus any prior partial runs in the same
  // results dir. summarize.ts is read-only over results/ — safe to call.
  console.log('\nregenerating SUMMARY.md...');
  const summarize = spawnSync('npx', ['tsx', 'bench/swe-lite/summarize.ts'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (summarize.status !== 0) {
    console.error('(summary generation failed — run `npx tsx bench/swe-lite/summarize.ts` manually)');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
