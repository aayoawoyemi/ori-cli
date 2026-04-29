/**
 * Centralized exit/cleanup lifecycle.
 *
 * Why this module exists:
 *   Before this lived here, src/index.ts had three independent exit paths:
 *     1. Happy-path Ink exit (waitUntilExit() resolves → vault.disconnect()
 *        + replHandle.shutdown() called explicitly at index.ts:776-778).
 *     2. SIGINT/SIGTERM handlers (index.ts:51-52) that called exitParchment()
 *        + process.exit(0) — NO vault/bridge cleanup.
 *     3. uncaughtException/unhandledRejection (index.ts:791-799) — same gap.
 *   The diagnosis pass on 2026-04-29 confirmed this was the source of the
 *   "11 zombie ori-memory subprocesses on the user's machine" pathology:
 *   any non-happy exit (Ctrl+C during startup, crash, terminal close)
 *   orphaned the MCP children. Each child holds ~270MB of embedding model
 *   weights, so 11 zombies ≈ 3GB of permanently-leaked RAM.
 *
 * Design:
 *   - Two registries: sync cleanups (always-safe, fast — terminal restore,
 *     tree-kills) and async cleanups (vault.disconnect, bridge.shutdown).
 *     The split matters because process.on('exit') CANNOT await — the only
 *     thing that runs reliably there is sync.
 *   - runCleanup() runs sync first, then awaits async with an overall budget
 *     (Promise.race against a default 3s grace). Slow cleanups don't trap us
 *     in an indefinite shutdown.
 *   - registerLifecycleHandlers() is called once from index.ts at startup,
 *     wires every signal we care about. Re-entry is guarded — only the first
 *     signal triggers cleanup; subsequent signals during shutdown are ignored
 *     (prevents "Ctrl+C twice = panic-exit" from skipping cleanup).
 *
 * Windows specifics:
 *   - SIGHUP doesn't exist on Windows; SIGBREAK does (Ctrl+Break in console).
 *   - Hard kill (TerminateProcess via Task Manager, kill -9 equivalent) gives
 *     us no opportunity to run handlers. Children are orphaned. The
 *     reapOrphans() helper covers this on the NEXT startup.
 *   - Console close on Windows fires CTRL_CLOSE_EVENT which Node surfaces as
 *     SIGHUP-or-similar — we wire SIGHUP/SIGBREAK both, plus the OS-level
 *     5-second timer Windows gives us before force-killing the parent is
 *     just barely enough for runCleanup's default 3s budget.
 */
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

type AsyncCleanup = () => Promise<void>;
type SyncCleanup = () => void;

const asyncCleanups: AsyncCleanup[] = [];
const syncCleanups: SyncCleanup[] = [];

let cleanupRunning = false;

export function onCleanupAsync(fn: AsyncCleanup): void {
  asyncCleanups.push(fn);
}

export function onCleanupSync(fn: SyncCleanup): void {
  syncCleanups.push(fn);
}

/**
 * Run all registered cleanups. Sync first (always safe), then async with a
 * total budget. Idempotent — second call during the same shutdown is a no-op.
 *
 * graceMs is the OVERALL budget for ALL async cleanups combined, not per-
 * cleanup. Default 3s — we already pay terminal restore + tree-kills (sync,
 * fast) before this; 3s for the async tail is enough for vault.disconnect
 * (which itself has a 2s force-kill timer) plus bridge.shutdown.
 */
export async function runCleanup(reason: string, opts: { graceMs?: number } = {}): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  appendDiagnostic({ event: 'cleanup_start', reason, sync_count: syncCleanups.length, async_count: asyncCleanups.length });
  const t0 = Date.now();

  // Sync cleanups always run, in registration order. Each is wrapped in
  // try/catch — one failing handler must not block the rest.
  for (const fn of syncCleanups) {
    try { fn(); } catch (err) {
      appendDiagnostic({ event: 'cleanup_sync_error', reason, error: (err as Error).message });
    }
  }

  // Async cleanups run in parallel with an overall budget. allSettled means
  // a rejecting cleanup doesn't short-circuit the others; Promise.race with
  // a setTimeout caps the total wait. Cleanups that haven't completed when
  // the budget expires are abandoned — the OS will reap them when we exit.
  const grace = opts.graceMs ?? 3_000;
  await Promise.race([
    Promise.allSettled(asyncCleanups.map(fn => fn())),
    new Promise<void>(resolve => setTimeout(resolve, grace)),
  ]);

  appendDiagnostic({ event: 'cleanup_complete', reason, total_ms: Date.now() - t0 });
}

/**
 * Wire every exit path we can intercept to runCleanup(). Call once at startup
 * — re-registration would double-fire handlers and likely create chaos.
 *
 * The exit path matrix:
 *   - SIGINT (Ctrl+C from terminal): async cleanup, exit 0
 *   - SIGTERM (kill PID, systemd stop): async cleanup, exit 0
 *   - SIGHUP (POSIX terminal close): async cleanup, exit 0 — does not exist on Windows
 *   - SIGBREAK (Windows Ctrl+Break, console close): async cleanup, exit 0
 *   - 'exit' event: SYNC ONLY — Node fires this synchronously, awaits are
 *     ignored. The sync cleanup (terminal restore, tree-kill of children)
 *     runs and that's it. Async resources may leak but the OS reaps them.
 *   - uncaughtException: log via logCrash, then async cleanup with exit 1.
 *   - unhandledRejection: log via logCrash, then async cleanup, NO exit
 *     (preserves pre-existing don't-die-on-rejection behavior — many
 *     unhandled rejections in async paths are recoverable; killing the
 *     session on every one would be hostile).
 *
 * The `exited` flag prevents double-handling. If a SIGINT arrives during
 * cleanup of a previous SIGINT, we ignore it. Users hitting Ctrl+C twice
 * in panic mode shouldn't accidentally skip our cleanup window.
 */
export function registerLifecycleHandlers(opts: {
  logCrash?: (label: string, err: unknown) => void;
} = {}): void {
  let handled = false;
  const logCrash = opts.logCrash ?? (() => {});

  const handleSignal = (signal: NodeJS.Signals, exitCode = 0): void => {
    if (handled) return;
    handled = true;
    void runCleanup(String(signal)).finally(() => process.exit(exitCode));
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  // SIGHUP only exists on POSIX (terminal hangup, parent process death).
  // On Windows, Node simulates a SIGHUP-like signal for some console events
  // — wire it conditionally so we don't error on attach.
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => handleSignal('SIGHUP'));
  } else {
    // SIGBREAK is the Windows-specific signal for Ctrl+Break and (sometimes)
    // console-close events. Better than nothing on Windows, where the OS
    // gives us ~5s before force-killing the parent on console close.
    process.on('SIGBREAK', () => handleSignal('SIGBREAK'));
  }

  process.on('exit', () => {
    // Cannot await here — this runs inside Node's exit hook synchronously.
    // The sync registry covers terminal restore + child tree-kill, which
    // is the floor we always want. Async cleanups (vault.disconnect's stdin
    // EOF, bridge.shutdown's graceful op) may not complete; the OS reaps
    // them. That's acceptable — the alternative is leaving zombies.
    if (handled) return;
    handled = true;
    for (const fn of syncCleanups) {
      try { fn(); } catch { /* swallow; we're exiting */ }
    }
  });

  process.on('uncaughtException', (err) => {
    logCrash('uncaughtException', err);
    if (handled) { process.exit(1); return; }
    handled = true;
    void runCleanup('uncaughtException').finally(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logCrash('unhandledRejection', reason);
    // Pre-existing behavior: don't exit on unhandled rejections — many are
    // recoverable. But fire cleanup anyway because unhandled rejections in
    // async code paths often correlate with bridge or vault death; better to
    // shed subprocesses we no longer trust than to leak them. Don't gate on
    // `handled` here because we deliberately don't set it — subsequent
    // rejections should re-fire cleanup if they happen.
    void runCleanup('unhandledRejection');
  });
}

/**
 * One-shot orphan reaper. Run at startup, BEFORE we spawn new ori-memory
 * subprocesses, to clean up zombies left behind by previous aries sessions
 * that exited hard (terminal close, kill -9, crash before our cleanup
 * handlers ran).
 *
 * Safety contract:
 *   - Only kills processes whose command line matches one of the provided
 *     fingerprints (substrings — caller passes specific matchers like
 *     'ori-memory' AND 'serve --mcp').
 *   - Only kills if the process's parent PID is no longer alive. A live
 *     parent means the subprocess belongs to another aries session (or to
 *     Claude Desktop, Cursor, etc.) — we never kill those. "Definitively
 *     orphaned" = ppid is dead.
 *   - Best-effort: any error is swallowed and logged to diagnostics. We
 *     never want a startup hang from this.
 *
 * Implementation:
 *   - Windows: WMIC for the listing (returns CSV), taskkill /F for the kill.
 *     WMIC is deprecated since Windows 10 21H1 but still ships and works
 *     reliably; switch to PowerShell Get-CimInstance if WMIC is removed.
 *   - POSIX: ps -eo pid,ppid,command for listing, kill -TERM then -KILL.
 *
 * Returns the number of orphans actually killed. Non-blocking — runs in
 * the foreground but with bounded subprocess work (~100ms typical).
 */
export function reapOrphans(fingerprints: string[]): number {
  if (fingerprints.length === 0) return 0;

  let killed = 0;
  try {
    if (process.platform === 'win32') {
      killed = reapOrphansWindows(fingerprints);
    } else {
      killed = reapOrphansPosix(fingerprints);
    }
  } catch (err) {
    appendDiagnostic({ event: 'orphan_reaper_error', error: (err as Error).message });
  }

  if (killed > 0) {
    appendDiagnostic({ event: 'orphans_reaped', count: killed, fingerprints });
  }
  return killed;
}

function reapOrphansWindows(fingerprints: string[]): number {
  // WMIC outputs CSV: Node,CommandLine,ParentProcessId,ProcessId
  // We ignore the Node column (machine name) and parse the rest.
  const out = execSync(
    'wmic process get ProcessId,ParentProcessId,CommandLine /format:csv',
    { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 },
  );
  let killed = 0;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Node,')) continue;
    // CSV has commas inside CommandLine; split from the right since the
    // last two fields (PPID, PID) are guaranteed numeric.
    const lastComma = trimmed.lastIndexOf(',');
    const secondLastComma = trimmed.lastIndexOf(',', lastComma - 1);
    if (lastComma < 0 || secondLastComma < 0) continue;
    const pid = parseInt(trimmed.slice(lastComma + 1), 10);
    const ppid = parseInt(trimmed.slice(secondLastComma + 1, lastComma), 10);
    const cmdAndNode = trimmed.slice(0, secondLastComma);
    // cmdAndNode = "Node,CommandLine"; strip the Node hostname prefix.
    const firstComma = cmdAndNode.indexOf(',');
    const cmd = firstComma >= 0 ? cmdAndNode.slice(firstComma + 1) : cmdAndNode;
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (pid === process.pid) continue; // never kill ourselves
    // Fingerprint check: ALL substrings must be present (AND, not OR).
    if (!fingerprints.every(f => cmd.includes(f))) continue;
    // Orphan check: parent must be dead.
    if (isProcessAlive(ppid)) continue;
    // Kill with /T (tree) /F (force). Tree-kill in case the orphan itself
    // spawned children we don't want around either.
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 2_000 });
      killed++;
    } catch {
      // Already dead, or access denied. Either way, move on.
    }
  }
  return killed;
}

function reapOrphansPosix(fingerprints: string[]): number {
  // ps -eo pid,ppid,command — fixed-width-ish; we split on whitespace and
  // join the tail as the command.
  const out = execSync('ps -eo pid,ppid,command', {
    encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  });
  let killed = 0;
  const lines = out.split('\n').slice(1); // skip header
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    const cmd = parts.slice(2).join(' ');
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    if (pid === process.pid) continue;
    if (!fingerprints.every(f => cmd.includes(f))) continue;
    if (isProcessAlive(ppid)) continue;
    try {
      process.kill(pid, 'SIGTERM');
      // Give SIGTERM 1s; if still alive, SIGKILL.
      setTimeout(() => {
        try { process.kill(pid, 'SIGKILL'); } catch { /* dead already */ }
      }, 1_000);
      killed++;
    } catch {
      // Already dead.
    }
  }
  return killed;
}

/**
 * Process-liveness probe. process.kill(pid, 0) sends no signal but returns
 * normally if the PID exists and is owned by us, throws ESRCH if dead.
 * EPERM means the PID exists but we don't own it — for our purposes that
 * counts as alive (we're not killing other users' processes anyway).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true; // exists, owned by someone else
    return false; // ESRCH or anything else — treat as dead
  }
}

/**
 * Append one JSONL record to ~/.aries/diagnostics/lifecycle.jsonl. Mirror
 * of bridge.ts's appendDiagnostic but for lifecycle events. Best-effort —
 * any IO failure is swallowed; diagnostics must never break exit paths.
 */
function appendDiagnostic(record: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), '.aries', 'diagnostics');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    appendFileSync(join(dir, 'lifecycle.jsonl'), line, 'utf8');
  } catch {
    // Never let diagnostics break shutdown.
  }
}
