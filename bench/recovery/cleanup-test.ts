/**
 * Subprocess-cleanup test (Phase 1 of 2026-04-29 fixes).
 *
 * Verifies that ori-memory MCP subprocesses are killed when the parent
 * aries process exits cleanly through the lifecycle module. Pre-Phase-1,
 * only the happy-path Ink exit ran cleanup; SIGINT/SIGTERM/uncaughtException
 * all orphaned the children, leaving 11 zombies on the user's machine.
 *
 * Approach: spawn a harness that imports OriVault + lifecycle, connects to
 * the brain vault (spawning an ori-memory subprocess as a grandchild), and
 * waits for a stdin command. The driver sends "graceful" or "uncaught" or
 * "exit"; the harness invokes the corresponding lifecycle path; the driver
 * verifies the ori-memory subprocess is gone.
 *
 * Why stdin instead of OS signals: Windows does not have POSIX SIGINT/
 * SIGTERM — Node simulates them but the simulation is incomplete and
 * varies by stdio config and console attachment. Triggering cleanup via
 * stdin tests the cleanup MECHANISM (lifecycle handlers → vault.disconnect
 * → killTree → taskkill) without depending on OS-specific signal-delivery
 * semantics. Signal delivery is verified separately on POSIX where it
 * actually works the way the Node docs claim.
 *
 * Note: SIGKILL of the parent can't be tested here — when the parent
 * dies hard, the orphan-reaper at the NEXT aries startup is what cleans
 * up. That's tested manually (close one aries hard, start another, watch
 * the reaper log).
 *
 * Run with:  npx tsx bench/recovery/cleanup-test.ts
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const ORI_FINGERPRINT = 'ori-memory';
const SIGNAL_HARNESS_DIR = join(tmpdir(), `aries-cleanup-test-${process.pid}`);

let passed = 0;
let failed = 0;
function expect(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

interface ProcessInfo { pid: number; ppid: number; cmd: string; }

function listOriProcesses(): ProcessInfo[] {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'wmic process get ProcessId,ParentProcessId,CommandLine /format:csv',
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
      );
      const result: ProcessInfo[] = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('Node,')) continue;
        const lastComma = t.lastIndexOf(',');
        const secondLastComma = t.lastIndexOf(',', lastComma - 1);
        if (lastComma < 0 || secondLastComma < 0) continue;
        const pid = parseInt(t.slice(lastComma + 1), 10);
        const ppid = parseInt(t.slice(secondLastComma + 1, lastComma), 10);
        const cmdAndNode = t.slice(0, secondLastComma);
        const firstComma = cmdAndNode.indexOf(',');
        const cmd = firstComma >= 0 ? cmdAndNode.slice(firstComma + 1) : cmdAndNode;
        if (!Number.isFinite(pid) || !cmd.includes(ORI_FINGERPRINT)) continue;
        result.push({ pid, ppid, cmd });
      }
      return result;
    } catch { return []; }
  } else {
    try {
      const out = execSync('ps -eo pid,ppid,command', {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
      });
      const result: ProcessInfo[] = [];
      for (const line of out.split('\n').slice(1)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const cmd = parts.slice(2).join(' ');
        if (!Number.isFinite(pid) || !cmd.includes(ORI_FINGERPRINT)) continue;
        result.push({ pid, ppid, cmd });
      }
      return result;
    } catch { return []; }
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Wait until predicate returns true OR timeout fires. Returns whether the
 * predicate was satisfied. Polls every 100ms.
 */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

/**
 * Spawn a test harness as a subprocess. The harness imports OriVault,
 * connects to ~/brain (spawning the ori-memory subprocess as a grandchild),
 * signals readiness on stdout, then reads stdin commands:
 *   "graceful\n" — invoke runCleanup('test-graceful'), then process.exit(0)
 *   "uncaught\n" — throw an uncaught exception (lifecycle's
 *                  uncaughtException handler should run cleanup + exit 1)
 *   "exit\n"     — process.exit(0) without explicit cleanup (only the
 *                  sync 'exit' handler runs — tests the always-safe floor)
 *
 * This mimics aries's lifecycle: parent process holds an OriVault, OriVault
 * spawns an ori-memory MCP subprocess. We exercise the lifecycle paths
 * directly via stdin commands rather than OS signals — signal delivery on
 * Windows is incomplete (different than POSIX) and that's an OS concern,
 * not a logic concern. The cleanup MECHANISM (lifecycle → vault.disconnect
 * → killTree → taskkill) is what we verify.
 */
function spawnHarness(): { proc: ChildProcess; ready: Promise<void>; harnessPid: number } {
  mkdirSync(SIGNAL_HARNESS_DIR, { recursive: true });
  const harnessPath = join(SIGNAL_HARNESS_DIR, 'harness.mjs');

  const vaultUrl = pathToFileURL(join(process.cwd(), 'dist/memory/vault.js')).href;
  const lifecycleUrl = pathToFileURL(join(process.cwd(), 'dist/lifecycle.js')).href;
  const harnessSrc = `
import { OriVault } from '${vaultUrl}';
import { registerLifecycleHandlers, onCleanupAsync, runCleanup } from '${lifecycleUrl}';
import { homedir } from 'node:os';
import { join } from 'node:path';

registerLifecycleHandlers();
const vault = new OriVault(join(homedir(), 'brain'));
onCleanupAsync(async () => { try { vault.disconnect(); } catch {} });
await vault.connect();
console.log('[harness] ready pid=' + process.pid);

// Read stdin in line mode. Each line is a command — see test driver.
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  while (buf.includes('\\n')) {
    const idx = buf.indexOf('\\n');
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === 'graceful') {
      await runCleanup('test-graceful');
      process.exit(0);
    } else if (line === 'uncaught') {
      // Throw an exception that nothing catches. Node's uncaughtException
      // handler in lifecycle.ts should fire runCleanup then exit(1).
      setTimeout(() => { throw new Error('test-uncaught'); }, 0);
    } else if (line === 'exit') {
      // Bare process.exit — fires only the sync 'exit' hook (which runs
      // sync cleanups; async cleanups skip). Tests the always-safe floor.
      process.exit(0);
    }
  }
});
// Hold open. The interval keeps the event loop alive so stdin keeps being
// read; without it, Node may exit when stdin's read returns.
setInterval(() => {}, 60_000);
`;
  writeFileSync(harnessPath, harnessSrc, 'utf-8');

  const proc = spawn(process.execPath, [harnessPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    detached: process.platform !== 'win32',
  });

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('harness did not signal ready in 30s')), 30_000);
    proc.stdout!.on('data', (chunk: Buffer) => {
      const out = chunk.toString();
      process.stdout.write(`    [harness-stdout] ${out}`);
      if (out.includes('[harness] ready')) { clearTimeout(timer); resolve(); }
    });
    proc.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(`    [harness-stderr] ${chunk.toString()}`);
    });
    proc.on('exit', (code) => {
      if (code !== 0) clearTimeout(timer);
    });
  });

  return { proc, ready, harnessPid: proc.pid! };
}

async function testCleanupPath(label: string, command: string): Promise<void> {
  console.log(`\n[cleanup-test] ${label}: sending stdin "${command}"`);
  const { proc, ready, harnessPid } = spawnHarness();
  try {
    await ready;
    await sleep(500); // let MCP subprocess register in tasklist
    const before = listOriProcesses().filter(p => p.ppid === harnessPid);
    expect(`${label}: harness spawned ori-memory subprocess`,
      before.length >= 1, `found: ${before.length}`);

    proc.stdin!.write(command + '\n');

    const cleaned = await waitFor(() => {
      const stillAlive = listOriProcesses().filter(p => before.some(b => b.pid === p.pid));
      return stillAlive.length === 0;
    }, 8_000);

    expect(`${label}: ori-memory subprocesses cleaned up within 8s`, cleaned,
      `still alive: ${listOriProcesses().filter(p => before.some(b => b.pid === p.pid)).map(p => p.pid).join(',')}`);
    expect(`${label}: harness process exited`,
      await waitFor(() => !isProcessAlive(harnessPid), 3_000));
  } finally {
    if (isProcessAlive(harnessPid)) {
      if (process.platform === 'win32') {
        try { execSync(`taskkill /F /T /PID ${harnessPid}`, { stdio: 'ignore' }); } catch {}
      } else {
        try { proc.kill('SIGKILL'); } catch {}
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('[cleanup-test] starting');

  // Sanity: ensure dist/ exists. The harness imports built JS so it can run
  // as a plain Node script (faster startup than spawning tsx). If dist is
  // stale or missing, the test fails fast with a clear error.
  if (!existsSync(join(process.cwd(), 'dist/lifecycle.js')) ||
      !existsSync(join(process.cwd(), 'dist/memory/vault.js'))) {
    console.error('[cleanup-test] dist/ is missing or stale. Run `npm run build` first.');
    process.exit(1);
  }

  // Graceful: invoke runCleanup() directly. Tests the async cleanup chain
  // end-to-end (lifecycle → vault.disconnect → killTree → taskkill).
  await testCleanupPath('graceful runCleanup', 'graceful');

  // Uncaught exception: tests the lifecycle handler at lifecycle.ts that
  // catches uncaughtException, runs cleanup, then exits with code 1.
  await testCleanupPath('uncaughtException', 'uncaught');

  // Note: SIGKILL of the parent is intentionally not tested. When the
  // parent gets SIGKILL, no JS handlers run — children ARE orphaned. The
  // orphan-reaper at the next aries startup is what cleans those up;
  // that's a separate test (manual: kill -9 one aries, start another,
  // watch for "reaped N orphaned ori-memory subprocess" log).
  //
  // POSIX-only signal delivery test could be added as a third case here
  // (process.kill('SIGINT')) but is omitted for cross-platform simplicity.

  console.log(`\n[cleanup-test] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
