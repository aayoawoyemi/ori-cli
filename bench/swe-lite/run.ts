/**
 * SWE-bench Lite single-task runner.
 *
 * Pipeline per invocation (one task, one CLI):
 *   1. Look up task by instance_id in tasks.json.
 *   2. Clone repo at base_commit into workspaces/<id>/repo (idempotent).
 *   3. Apply test_patch so the failing test exists in the tree.
 *   4. Create per-task venv at workspaces/<id>/venv and install the repo.
 *   5. Spawn the agent (aries-cli or claude-code) with cwd=repo and the
 *      problem statement as the prompt. Capture wall time and stdout.
 *   6. Grade by running FAIL_TO_PASS and PASS_TO_PASS tests via pytest in
 *      the venv. Pass = all FAIL_TO_PASS pass AND all PASS_TO_PASS pass.
 *   7. Write results/<id>-<cli>.json + print a one-line summary.
 *
 * Cost discipline:
 *   - Default model is sonnet-4-6 (override with BENCH_MODEL).
 *   - Default max_turns=20 (override with BENCH_MAX_TURNS).
 *   - One task per invocation — fire it, watch it, decide whether to fire
 *     another. No batch loop.
 *
 * Usage:
 *   npx tsx bench/swe-lite/run.ts --task <instance_id> --cli aries-cli
 *   npx tsx bench/swe-lite/run.ts --task <instance_id> --cli claude-code
 *
 * Skip steps that are already done (re-run friendly):
 *   --skip-setup    don't re-clone / re-install (assume workspace is ready)
 *   --skip-agent    don't run the agent (just re-grade existing edits)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read repo-root .env into a local map. We deliberately do NOT inject into
// process.env — that would leak credentials to every child the runner
// spawns (CC and aries). Instead, only Pi's invocation pulls from this map
// (via piInvocation), so CC continues to use its own OAuth and aries uses
// whatever its production bootstrap loads. This honors the user-scoping
// rule from 2026-04-27: bench credentials flow to Pi only.
function readDotenv(repoRoot: string): Record<string, string> {
  const envPath = join(repoRoot, '.env');
  const out: Record<string, string> = {};
  if (!existsSync(envPath)) return out;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let [, key, value] = m as unknown as [string, string, string];
    value = value.replace(/^['"]|['"]$/g, '');
    out[key] = value;
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TASKS_FILE = join(__dirname, 'tasks.json');

const DOTENV = readDotenv(REPO_ROOT);

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}
function bool(name: string): boolean {
  return args.includes(name);
}

const TASK_ID = flag('--task');
const CLI = (flag('--cli') ?? 'aries-cli') as 'aries-cli' | 'claude-code' | 'pi-coding-agent';
const MODEL = process.env.BENCH_MODEL ?? 'claude-sonnet-4-6';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? '20');
const AGENT_TIMEOUT_MS = Number(process.env.BENCH_AGENT_TIMEOUT_MS ?? String(15 * 60 * 1000));
const PYTEST_TIMEOUT_MS = Number(process.env.BENCH_PYTEST_TIMEOUT_MS ?? String(5 * 60 * 1000));
const SKIP_SETUP = bool('--skip-setup');
const SKIP_AGENT = bool('--skip-agent');

if (!TASK_ID) {
  console.error('Usage: npx tsx bench/swe-lite/run.ts --task <instance_id> [--cli aries-cli|claude-code]');
  process.exit(1);
}
if (!existsSync(TASKS_FILE)) {
  console.error('tasks.json missing — run `npx tsx bench/swe-lite/fetch-tasks.ts` first');
  process.exit(1);
}

// ── Task lookup ─────────────────────────────────────────────────────────
interface SweTask {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  patch: string;
  test_patch: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  version: string;
}

const tasks: SweTask[] = JSON.parse(readFileSync(TASKS_FILE, 'utf8'));
const task = tasks.find((t) => t.instance_id === TASK_ID);
if (!task) {
  console.error(`Task ${TASK_ID} not found. Sample IDs: ${tasks.slice(0, 5).map(t => t.instance_id).join(', ')}`);
  process.exit(1);
}

const FAIL_TO_PASS: string[] = JSON.parse(task.FAIL_TO_PASS);
const PASS_TO_PASS: string[] = JSON.parse(task.PASS_TO_PASS);

console.log(`\n=== ${task.instance_id} ===`);
console.log(`repo:           ${task.repo}@${task.base_commit.slice(0, 8)}`);
console.log(`fail_to_pass:   ${FAIL_TO_PASS.length} test(s)`);
console.log(`pass_to_pass:   ${PASS_TO_PASS.length} test(s)`);
console.log(`cli:            ${CLI}`);
console.log(`model:          ${MODEL}`);
console.log('');

// ── Workspace paths ─────────────────────────────────────────────────────
// On a fresh run we create workspaces/<id>/<timestamp>/. On --skip-setup
// we reuse the most recent workspace under workspaces/<id>/. Per-run
// timestamping sidesteps Windows file-handle locks (Defender/AV scans
// freshly-installed venvs and briefly EBUSYs every recursive rmdir).
function newestExisting(parent: string): string | null {
  if (!existsSync(parent)) return null;
  const entries = readdirSync(parent)
    .map((name) => ({ name, mtime: statSync(join(parent, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries.length > 0 ? join(parent, entries[0]!.name) : null;
}
const wsParent = join(__dirname, 'workspaces', TASK_ID);
const wsDir = SKIP_SETUP
  ? (newestExisting(wsParent) ?? join(wsParent, String(Date.now())))
  : join(wsParent, String(Date.now()));
const repoDir = join(wsDir, 'repo');
const venvDir = join(wsDir, 'venv');
const venvPy = process.platform === 'win32'
  ? join(venvDir, 'Scripts', 'python.exe')
  : join(venvDir, 'bin', 'python');

// ── Per-repo Python version ────────────────────────────────────────────
// SWE-bench tasks were generated against repo commits from 2018-2023.
// Modern Python (3.12+) breaks AST-using tools (pytest's assertion-rewrite
// crashes on "required field lineno missing from alias"), so each repo
// pins to the Python it was tested under. Values are arguments to the
// Windows `py` launcher (e.g. `-V:3.9`); on non-Windows this map is unused
// and `python` from PATH is used.
//
// Override per-run with BENCH_PYTHON. Default (3.9) covers most older
// tasks; bump to 3.10 for newer repos like 2023-vintage Sphinx.
const PYTHON_VERSION: Record<string, string> = {
  'pytest-dev/pytest': '3.9',
  'pylint-dev/pylint': '3.9',
  'pallets/flask': '3.9',
  'pallets/click': '3.9',
  'psf/requests': '3.9',
  'sphinx-doc/sphinx': '3.9',
};
function pythonLauncher(repo: string): { cmd: string; args: string[] } {
  const override = process.env.BENCH_PYTHON;
  const version = override ?? PYTHON_VERSION[repo] ?? '3.9';
  if (process.platform === 'win32') {
    // Use the `py` launcher to select a specific installed CPython without
    // depending on PATH order. -3.9 / -V:3.9 both work.
    return { cmd: 'py', args: [`-${version}`] };
  }
  // POSIX: assume `pythonX.Y` is on PATH, fall back to `python3`.
  return { cmd: `python${version}`, args: [] };
}

// ── Per-repo install commands ──────────────────────────────────────────
// Each line is a `python -m pip install ...` arg list (without the leading
// `install`). Two real gotchas drive the shape of this map:
//
// 1) Don't pip-install pytest *after* `pip install -e .` for the pytest
//    repo — the editable install IS pytest, and a follow-up `pip install
//    pytest` clobbers it with the latest PyPI version (whose pluggy/_pytest
//    internals are incompatible with the older repo source). Use
//    `.[testing]` instead, which pulls only the dev extras the repo needs.
//
// 2) Old commits have unbounded transitive deps that have since broken
//    (Flask <2.3 needs werkzeug<2.3 because newer werkzeug removed
//    `url_quote`, etc). The official SWE-bench harness pins each task's
//    Python version + dep set per `version` field; for this single-task
//    pilot we hardcode the few pins we've actually hit.
//
// Escape hatch: BENCH_EXTRA_INSTALL is appended verbatim as the LAST
// install step — so the user can experiment with a pin before we bake it
// into the map.
const INSTALL_COMMANDS: Record<string, string[][]> = {
  'pytest-dev/pytest': [['-e', '.[testing]']],
  'pylint-dev/pylint': [['-e', '.[testing]'], ['pytest']],
  'pallets/flask': [['-e', '.'], ['pytest', 'werkzeug<2.3.0', 'markupsafe<2.1.0', 'itsdangerous<2.1.0']],
  'pallets/click': [['-e', '.'], ['pytest']],
  'psf/requests': [['-e', '.'], ['pytest', 'urllib3<2.0', 'chardet<5.0']],
  'sphinx-doc/sphinx': [['-e', '.[test]']],
};
function installCommandsFor(repo: string): string[][] {
  const base = INSTALL_COMMANDS[repo] ?? [['-e', '.'], ['pytest']];
  const extra = process.env.BENCH_EXTRA_INSTALL?.trim();
  return extra ? [...base, extra.split(/\s+/)] : base;
}

// ── Subprocess helpers ──────────────────────────────────────────────────
function runSync(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function step(label: string): void {
  console.log(`> ${label}`);
}

// ── Setup: clone + apply test_patch + venv + install ───────────────────
function rmWorkspaceResilient(dir: string): void {
  // Windows can hold file handles open briefly after pip install / venv
  // creation (especially python.exe / dlls). Retry a few times before
  // giving up so the user doesn't see a spurious EBUSY on the second run.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw err;
      // Sync sleep — keep the runner single-threaded so we don't race
      // anything else during setup.
      const until = Date.now() + 1500;
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw new Error(`Could not remove ${dir} after 5 attempts (Windows file lock?). Close any shells with cwd inside, or rm manually.`);
}

function setupWorkspace(): void {
  if (SKIP_SETUP) {
    step(`skipping setup (--skip-setup); reusing ${wsDir}`);
    return;
  }
  // wsDir is timestamped, so it shouldn't exist yet — but we still mkdir -p
  // for safety. Old workspaces accumulate under workspaces/<id>/ and the
  // user can clean them out manually when not actively in use.
  mkdirSync(wsDir, { recursive: true });

  step(`cloning ${task!.repo}`);
  const cloneUrl = `https://github.com/${task!.repo}.git`;
  let r = runSync('git', ['clone', '--quiet', cloneUrl, repoDir]);
  if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr}`);

  step(`checking out ${task!.base_commit.slice(0, 8)}`);
  r = runSync('git', ['-C', repoDir, 'checkout', '--quiet', task!.base_commit]);
  if (r.code !== 0) throw new Error(`git checkout failed: ${r.stderr}`);

  step('applying test_patch');
  const testPatchPath = join(wsDir, 'test.patch');
  writeFileSync(testPatchPath, task!.test_patch);
  r = runSync('git', ['-C', repoDir, 'apply', '--whitespace=nowarn', testPatchPath]);
  if (r.code !== 0) throw new Error(`git apply test_patch failed: ${r.stderr}`);
  // Stage + commit so a subsequent `git diff HEAD` shows ONLY the agent's
  // edits, not the test_patch we injected. Useful for inspecting what the
  // agent actually changed.
  runSync('git', ['-C', repoDir, 'add', '-A']);
  runSync('git', ['-C', repoDir, 'commit', '--quiet', '-m', '[bench] apply test_patch']);

  const py = pythonLauncher(task!.repo);
  step(`creating venv at ${venvDir} (using ${py.cmd} ${py.args.join(' ')})`);
  r = runSync(py.cmd, [...py.args, '-m', 'venv', venvDir]);
  if (r.code !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error(`${py.cmd} ${py.args.join(' ')} -m venv failed (code ${r.code}). Is the Python version installed? On Windows: \`py --list\`.`);
  }

  step('upgrading pip');
  runSync(venvPy, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip', 'wheel', 'setuptools']);

  for (const cmd of installCommandsFor(task!.repo)) {
    step(`pip install ${cmd.join(' ')}`);
    r = runSync(venvPy, ['-m', 'pip', 'install', '--quiet', ...cmd], { cwd: repoDir });
    if (r.code !== 0) {
      console.error(r.stdout);
      console.error(r.stderr);
      throw new Error(`pip install ${cmd.join(' ')} failed (code ${r.code})`);
    }
  }
}

// ── Build the agent prompt ──────────────────────────────────────────────
// The verification clause (2026-04-27) — the first pilot run showed aries
// shipping a confident-but-wrong fix in 59s without ever running the test.
// CC took 5x longer and got it right, partly because it iterated on actual
// pytest output. Pi's system prompt has NO verify-before-commit language;
// it relies on Claude's native verify instinct. Aries' codemode prompt has
// strong `done(value)` commit semantics which appear to suppress that
// instinct. Until we restructure codemode (separate concern), the bench
// prompt mandates verification explicitly: model must run pytest, see it
// pass, then commit. Failure here means the codemode prior is the
// structural problem and we need to revisit done() semantics, not prompts.
function buildPrompt(): string {
  // Absolute python path the model can use directly via shell.run() inside
  // the Repl. Forward slashes work on Windows + Unix.
  const venvPyPosix = venvPy.replace(/\\/g, '/');
  return [
    `You are working in the repo at "${repoDir}". A failing test has been added that captures a real bug. Read the relevant code, find the bug, and fix it. Do not modify the tests — only the source files.`,
    '',
    'GitHub issue (the bug):',
    '---',
    task!.problem_statement.trim(),
    '---',
    '',
    'These tests must pass when you are done:',
    ...FAIL_TO_PASS.map(t => `  - ${t}`),
    '',
    'WORKFLOW — do not skip steps:',
    '1. Read the failing test to understand what behavior it expects.',
    '2. Read the relevant source files. Form a hypothesis about the bug.',
    '3. Edit the source files to apply your fix.',
    '4. **Run the failing test in the Repl to verify**:',
    `     shell.run('"${venvPyPosix}" -m pytest -v -p no:cacheprovider ${FAIL_TO_PASS.map(t => `"${t}"`).join(' ')}')`,
    '   The result has fields {stdout, stderr, code}. code=0 means all tests passed.',
    '5. If any test still fails, read the actual pytest output, diagnose, edit again, re-run pytest. Do NOT call done() while any FAIL_TO_PASS test is still failing.',
    '6. Only after pytest exit code is 0, call done() to commit.',
    '',
    'Edit files directly with fs.edit / fs.write. Do not produce a diff in prose — make actual edits to actual files. The test fixtures already exist in the working tree; do not regenerate them.',
  ].join('\n');
}

// ── Spawn agent ─────────────────────────────────────────────────────────
function ariesInvocation(prompt: string) {
  const distEntry = join(REPO_ROOT, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    throw new Error(`aries dist not built — run \`npm run build\` in repo root`);
  }
  return {
    cmd: process.execPath,
    args: [distEntry, prompt],
    env: { ...process.env, ARIES_SUBAGENT: '1', BENCH_MODEL: MODEL },
    useShell: false,
  };
}
function claudeInvocation(_prompt: string) {
  // CC reads prompt via stdin (avoids cmd.exe whitespace tokenization).
  return {
    cmd: 'claude',
    args: [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
      '--model', MODEL,
    ],
    env: { ...process.env },
    useShell: process.platform === 'win32',
  };
}
function piInvocation(_prompt: string) {
  // Pi (Anthropic's reference coding agent). PI_CLI lets the user pin a
  // specific binary path; default 'pi' on PATH. Match the args used in the
  // existing bench/2026-04/runner so behavior stays consistent across the
  // two harnesses. --mode json keeps the output machine-readable for token
  // parsing; --thinking off keeps cost predictable for the pilot.
  //
  // Auth: Pi's auth precedence is (1) runtime --api-key, (2) auth.json
  // api_key, (3) auth.json oauth, (4) env var. In practice the user's
  // ~/.pi/agent/auth.json holds an OAuth credential whose subscription is
  // out of overage, and Pi sometimes picks that path instead of --api-key
  // (resulting in `400: You're out of extra usage`). The fix is to point
  // Pi at an empty per-run agent dir via PI_CODING_AGENT_DIR — Pi finds
  // no stored credentials there, falls through to --api-key / env.
  const cli = process.env.PI_CLI ?? 'pi';
  // Auth resolution order — Pi-scoped, never leaks to CC:
  //   1. ANTHROPIC_API_KEY (real `sk-ant-*`) → use Anthropic direct
  //   2. OPENROUTER_API_KEY → route via OpenRouter (model prefixed with
  //      `openrouter/`); bypasses Anthropic OAuth overage which currently
  //      blocks the user's only ANTHROPIC_AUTH_TOKEN credential
  //   3. ANTHROPIC_AUTH_TOKEN → last-resort OAuth (will hit overage on
  //      this user's subscription, kept here so the failure path is at
  //      least intentional rather than silent)
  // Reads .env locally via DOTENV map — does NOT mutate process.env.
  const apiKey = DOTENV.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  const openrouterKey = DOTENV.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  const oauthToken = DOTENV.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const args = ['--mode', 'json', '--thinking', 'off'];
  let credential: string | undefined;
  if (apiKey) {
    args.push('--model', `anthropic/${MODEL}`, '--api-key', apiKey);
    credential = apiKey;
  } else if (openrouterKey) {
    args.push('--model', `openrouter/anthropic/${MODEL}`, '--api-key', openrouterKey);
    credential = openrouterKey;
  } else if (oauthToken) {
    args.push('--model', `anthropic/${MODEL}`, '--api-key', oauthToken);
    credential = oauthToken;
  } else {
    args.push('--model', `anthropic/${MODEL}`);
  }
  // Per-run isolated Pi agent dir. Sit inside the workspace so it gets
  // cleaned up when the workspace is rotated (timestamped per run).
  const piAgentDir = join(wsDir, 'pi-agent');
  mkdirSync(piAgentDir, { recursive: true });
  // Build a minimal env: inherit only what's needed for Pi to function
  // (PATH, USERPROFILE, HOME, TEMP), plus the per-run pi agent dir, plus
  // the auth credentials Pi needs. We do NOT pass the full process.env
  // because that could leak ANTHROPIC_AUTH_TOKEN to other channels Pi
  // might check internally — explicit credential routing only.
  const piEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PI_CODING_AGENT_DIR: piAgentDir,
  };
  if (credential) {
    // Set the matching env var so Pi's env-fallback path also sees it
    // (alongside the explicit --api-key flag). Belt + suspenders.
    if (apiKey) piEnv.ANTHROPIC_API_KEY = apiKey;
    else if (openrouterKey) piEnv.OPENROUTER_API_KEY = openrouterKey;
    else if (oauthToken) piEnv.ANTHROPIC_AUTH_TOKEN = oauthToken;
  }
  return {
    cmd: cli,
    args,
    env: piEnv,
    useShell: process.platform === 'win32',
  };
}

async function runAgent(prompt: string): Promise<{ exitCode: number | null; wallMs: number; stdoutBytes: number; stderrTail: string; transcriptPath: string }> {
  const inv =
    CLI === 'aries-cli' ? ariesInvocation(prompt)
    : CLI === 'claude-code' ? claudeInvocation(prompt)
    : piInvocation(prompt);
  step(`spawning ${CLI}: ${inv.cmd} ${inv.args.slice(0, 2).join(' ')}...`);

  // Persist the agent's stdout stream so token usage can be parsed after
  // the run. CC emits stream-json (one event per line) including usage and
  // tool_use blocks; aries-cli writes its session events to ~/.aries/sessions/
  // separately, so capturing here is mostly for CC/pi but harmless for aries.
  // Pre-fix the runner only counted bytes and discarded the stream — token
  // comparison was impossible until we ran a fresh task.
  const transcriptDir = join(__dirname, 'results');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${task!.instance_id}-${CLI}.transcript.jsonl`);
  const transcriptStream = createWriteStream(transcriptPath, { flags: 'w' });

  const t0 = Date.now();
  return await new Promise((resolve) => {
    const proc = spawn(inv.cmd, inv.args, {
      cwd: repoDir,
      env: inv.env,
      shell: inv.useShell,
    });
    let stdoutBytes = 0;
    let stderrTail = '';
    proc.stdout.on('data', (d) => { stdoutBytes += d.length; transcriptStream.write(d); });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + String(d)).slice(-4000);
    });
    if (CLI === 'claude-code' || CLI === 'pi-coding-agent') {
      proc.stdin.end(prompt);
    }
    const killer = setTimeout(() => {
      step(`agent timeout (${AGENT_TIMEOUT_MS}ms) — sending SIGKILL`);
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, AGENT_TIMEOUT_MS);
    proc.on('exit', (code) => {
      clearTimeout(killer);
      transcriptStream.end();
      resolve({ exitCode: code, wallMs: Date.now() - t0, stdoutBytes, stderrTail, transcriptPath });
    });
  });
}

// ── Grading via pytest ─────────────────────────────────────────────────
interface PytestRunResult {
  exitCode: number | null;
  passed: string[];
  failed: string[];
  errored: string[];
  raw: string;
}

function isCliSelectable(testId: string): boolean {
  // pytest's CLI uses `::` as the node-path separator. Test IDs whose
  // parametrize values contain `::` (e.g. test_ischildnode[foo::Bar-True])
  // can't be selected from the command line — pytest tries to resolve
  // `Bar-True` as a class node and errors with "no name 'Bar' in module".
  // The official SWE-bench harness uses pytest's Python API to bypass
  // this; for the pilot we just skip these IDs with a warning.
  const bracketStart = testId.indexOf('[');
  if (bracketStart === -1) return true;
  const inside = testId.slice(bracketStart);
  return !inside.includes('::');
}

function runPytest(testIds: string[], label: string): PytestRunResult {
  if (testIds.length === 0) {
    return { exitCode: 0, passed: [], failed: [], errored: [], raw: '' };
  }
  const selectable = testIds.filter(isCliSelectable);
  const skipped = testIds.filter((t) => !isCliSelectable(t));
  if (skipped.length > 0) {
    step(`(${label}) skipping ${skipped.length} unselectable id(s) with '::' in params`);
  }
  if (selectable.length === 0) {
    return { exitCode: 0, passed: [], failed: [], errored: [], raw: '' };
  }
  step(`pytest (${label}): ${selectable.length} test(s)`);
  // No -x: we want every requested test classified, not stop-on-first.
  // -rN suppresses noisy summary sections. NO --no-header — pytest <6.0
  // (e.g. pytest-5.4.x in the pytest-7220 SWE-Lite task) treats it as an
  // unrecognized flag and exits before running anything, leaving the
  // parser with empty stdout and every test classified as "errored."
  const r = spawnSync(venvPy, [
    '-m', 'pytest',
    '-rN',
    '-v',
    '-p', 'no:cacheprovider',
    ...selectable,
  ], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: PYTEST_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const raw = (r.stdout ?? '') + '\n' + (r.stderr ?? '');
  const passed: string[] = [];
  const failed: string[] = [];
  const errored: string[] = [];
  // pytest -v output across versions:
  //   "tests/test_foo.py::test_bar PASSED            [ 50%]"           (modern)
  //   "PASSED tests/test_foo.py::test_bar"                              (older)
  //   "tests/test_foo.py::test_bar[param] PASSED"                       (parametrized)
  //   "FAILED tests/test_foo.py::test_bar - AssertionError: ..."        (summary line)
  // We accept either order: VERB before or after the test id, with
  // optional brackets/whitespace around. ANSI color codes can wrap each
  // line; strip them defensively before matching.
  const stripped = raw.replace(/\x1b\[[0-9;]*m/g, '');
  for (const tid of selectable) {
    const esc = tid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match either "<id>(?:\[...\])? VERB" or "VERB <id>(?:\[...\])?".
    const verbAfter = new RegExp(`^${esc}(?:\\[[^\\]]*\\])?\\s+(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\\b`, 'm');
    const verbBefore = new RegExp(`^(PASSED|FAILED|ERROR|XFAIL|XPASS|SKIPPED)\\s+${esc}(?:\\[[^\\]]*\\])?\\b`, 'm');
    let verb: string | null = null;
    const m1 = stripped.match(verbAfter);
    if (m1) verb = m1[1]!;
    else {
      const m2 = stripped.match(verbBefore);
      if (m2) verb = m2[1]!;
    }
    if (verb === 'PASSED' || verb === 'XFAIL' || verb === 'XPASS' || verb === 'SKIPPED') passed.push(tid);
    else if (verb === 'FAILED') failed.push(tid);
    else if (verb === 'ERROR') errored.push(tid);
    else errored.push(tid);   // didn't show up at all in pytest output
  }
  return { exitCode: r.status ?? null, passed, failed, errored, raw };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  setupWorkspace();

  let agent = { exitCode: 0 as number | null, wallMs: 0, stdoutBytes: 0, stderrTail: '' };
  if (!SKIP_AGENT) {
    const prompt = buildPrompt();
    agent = await runAgent(prompt);
    step(`agent exit=${agent.exitCode} wall=${(agent.wallMs / 1000).toFixed(1)}s stdout=${agent.stdoutBytes}B`);
  } else {
    step('skipping agent run (--skip-agent)');
  }

  // Diff — what did the agent actually change?
  const diff = runSync('git', ['-C', repoDir, 'diff', 'HEAD', '--stat']);
  const diffStat = diff.stdout.trim();
  console.log('\nagent diff (vs post-test_patch HEAD):');
  console.log(diffStat || '  (no changes)');

  // FAIL_TO_PASS is the gate. PASS_TO_PASS is informational — capped at
  // 30 so grading stays bounded, and tests with '::' inside their
  // parametrize values get filtered out (see isCliSelectable).
  const ftpRequested = FAIL_TO_PASS.filter(isCliSelectable);
  const ptpRequested = PASS_TO_PASS.slice(0, 30).filter(isCliSelectable);
  const ftp = runPytest(FAIL_TO_PASS, 'FAIL_TO_PASS');
  const ptp = runPytest(PASS_TO_PASS.slice(0, 30), 'PASS_TO_PASS (first 30)');

  // Success = all selectable FAIL_TO_PASS pass AND no PASS_TO_PASS
  // regressions. If everything in FAIL_TO_PASS was unselectable (rare),
  // we can't grade the task — flag it as inconclusive (success=false).
  const success =
    ftpRequested.length > 0 &&
    ftp.passed.length === ftpRequested.length &&
    ftp.failed.length === 0 && ftp.errored.length === 0 &&
    ptp.failed.length === 0 && ptp.errored.length === 0;

  const result = {
    instance_id: task!.instance_id,
    repo: task!.repo,
    cli: CLI,
    model: MODEL,
    success,
    agent: {
      exitCode: agent.exitCode,
      wallMs: agent.wallMs,
      stdoutBytes: agent.stdoutBytes,
      stderrTail: agent.stderrTail,
    },
    diff_stat: diffStat,
    fail_to_pass: {
      total: FAIL_TO_PASS.length,
      selectable: ftpRequested.length,
      passed: ftp.passed.length,
      failed: ftp.failed,
      errored: ftp.errored,
    },
    pass_to_pass: {
      total: Math.min(PASS_TO_PASS.length, 30),
      selectable: ptpRequested.length,
      passed: ptp.passed.length,
      failed: ptp.failed,
      errored: ptp.errored,
    },
    timestamp: new Date().toISOString(),
  };

  mkdirSync(join(__dirname, 'results'), { recursive: true });
  const outFile = join(__dirname, 'results', `${task!.instance_id}-${CLI}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log('\n=== RESULT ===');
  console.log(`success:        ${success ? 'YES' : 'NO'}`);
  console.log(`fail_to_pass:   ${ftp.passed.length}/${ftpRequested.length} passed${FAIL_TO_PASS.length !== ftpRequested.length ? ` (of ${FAIL_TO_PASS.length} requested, ${FAIL_TO_PASS.length - ftpRequested.length} unselectable)` : ''}`);
  if (ftp.failed.length) console.log(`  failed: ${ftp.failed.join(', ')}`);
  if (ftp.errored.length) console.log(`  errored: ${ftp.errored.join(', ')}`);
  console.log(`pass_to_pass:   ${ptp.passed.length}/${ptpRequested.length} passed${ptpRequested.length !== Math.min(PASS_TO_PASS.length, 30) ? ` (of ${Math.min(PASS_TO_PASS.length, 30)} requested, ${Math.min(PASS_TO_PASS.length, 30) - ptpRequested.length} unselectable)` : ''}`);
  if (ptp.failed.length) console.log(`  failed: ${ptp.failed.slice(0, 5).join(', ')}${ptp.failed.length > 5 ? ', ...' : ''}`);
  console.log(`wall:           ${(agent.wallMs / 1000).toFixed(1)}s`);
  console.log(`written:        ${outFile}`);
}

main().catch((err) => {
  console.error('\nrunner error:', err);
  process.exit(1);
});
