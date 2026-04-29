/**
 * Heartbeat + bindings cache validation (P1+P2 of bridge-with-invisible-recovery).
 *
 * What this proves:
 *   1. Heartbeat pings continue to respond to TS while a Repl exec is mid-flight.
 *      This is the crux of P1 — without the body's pre-join ping fast-path, a
 *      wedged exec would silence pings too. We submit a 10s `time.sleep(10)`
 *      via the bridge and assert that pongs arrive throughout the sleep window.
 *   2. Bindings cache populates as bind ops are called. We invoke configure +
 *      index + (skipped: vault/rlm because they need real targets) and assert
 *      the cache reflects the inputs.
 *
 * What this does NOT prove (deferred to later checkpoints):
 *   - Restart triggered by heartbeat miss (P3)
 *   - State replay on restart (P3)
 *   - Per-request timeout removal (P4)
 *   - Cancel protocol (P5)
 *
 * Run with:  npx tsx bench/recovery/heartbeat-test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import type { ReplEvent } from '../../src/repl/types.js';

const FAIL = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function run(): Promise<void> {
  // Track pong arrivals via a debug shim. The bridge doesn't emit a per-pong
  // event (heartbeat is internal observability) so we wrap process.write to
  // count pings sent and use the bridge's HEARTBEAT_INTERVAL_MS / DEADLINE_MS
  // as a yardstick for "did pongs arrive?"
  //
  // Simpler approach: subscribe to bridge_unhealthy. If pongs were arriving,
  // we never see unhealthy. If pongs failed during the sleep window, we'd
  // see unhealthy at sleep_start + interval*miss_threshold.
  let unhealthyFired = false;
  let unhealthyAt: number | null = null;
  const events: ReplEvent[] = [];

  const bridge = new ReplBridge({
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'bridge_unhealthy') {
        unhealthyFired = true;
        unhealthyAt = Date.now();
      }
    },
  });

  console.log('[1] Starting bridge…');
  const startMs = Date.now();
  await bridge.start();
  console.log(`    bridge_ready in ${Date.now() - startMs}ms`);

  // Wait briefly so the heartbeat can settle (first ping fires sync inside
  // startHeartbeat; we want at least one full round-trip confirmed before we
  // start the long exec).
  await new Promise((r) => setTimeout(r, 500));

  // ── Test 1: pongs survive a long exec ───────────────────────────────────
  // We can't `import time` (AST pre-pass blocks imports). shell.run is
  // actually a stronger test anyway — it forces the worker thread into a
  // callback wait (`Shell._call` blocks on threading.Event.wait), which is
  // the exact wedge shape the heartbeat is designed to detect. If pings
  // route correctly while a callback is in flight, they route correctly in
  // the wedge case too. On Windows we'd need `ping -n` for portability;
  // here we assume the host has `sleep` (Git Bash on Windows ships it,
  // mac/linux always do).
  console.log('[2] Submitting Repl with shell.run("sleep 10")…');
  const execStart = Date.now();
  const execPromise = bridge.exec({
    code: `
r = shell.run("sleep 10", timeout=15)
print(f"shell exited code={r['code']}")
`.trim(),
    timeout_ms: 20_000,
  });

  // Sample at 1s, 4s, 7s, 9s into the sleep — if pongs are silenced by the
  // wedged exec, unhealthy would fire at ~5s (3 misses × 1.5s deadline +
  // initial 0s offset). Anything past 6s with no unhealthy event is proof
  // that pongs are getting through.
  for (const checkAt of [1_000, 4_000, 7_000, 9_000]) {
    await new Promise((r) =>
      setTimeout(r, checkAt - (Date.now() - execStart)),
    );
    if (unhealthyFired) {
      FAIL(
        `bridge declared unhealthy at t+${unhealthyAt! - execStart}ms ` +
          `during a legitimate sleep(10) — heartbeat ping fast-path is not ` +
          `working. Pings are queueing behind the wedge.`,
      );
    }
    console.log(
      `    t+${checkAt}ms: still healthy (no unhealthy events, ${
        events.length
      } total events)`,
    );
  }

  const result = await execPromise;
  const execDur = Date.now() - execStart;
  console.log(`[3] Repl returned in ${execDur}ms`);
  console.log(`    full result: ${JSON.stringify({
    exception: result.exception,
    rejected: result.rejected,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    stdout_tail: result.stdout.slice(-200),
  }, null, 2)}`);
  if (result.exception) {
    FAIL(`Repl raised unexpectedly: ${result.exception}`);
  }
  if (result.rejected) {
    FAIL(`Repl rejected: ${result.rejected.reason}`);
  }
  // The first-exec banner is prepended to stdout; the print appears at the end.
  if (!result.stdout.includes('shell exited code=0')) {
    FAIL(`Repl stdout missing expected output. Tail: ${JSON.stringify(result.stdout.slice(-200))}`);
  }
  console.log(`    confirmed "shell exited code=0" in stdout ✓`);

  // Sanity: the exec really did take ~10s (not a fast-fail path).
  if (execDur < 8_000) {
    FAIL(`exec returned suspiciously fast (${execDur}ms) — sleep didn't sleep`);
  }

  if (unhealthyFired) {
    FAIL(`unhealthy fired post-exec — heartbeat lost track of the body`);
  }

  // ── Test 2: bindings cache populates ────────────────────────────────────
  console.log('[4] Calling configure + index, then dumping bindings…');

  await bridge.configure({
    project: process.cwd(),
    vaultGlobal: '/tmp/fake-vault-just-for-test',
    mode: 'project+vault',
    shell: 'bash',
  });

  const indexResult = await bridge.index({ repoPath: process.cwd() });
  if (indexResult.error) {
    console.log(`    index returned error: ${indexResult.error}`);
  } else {
    console.log(
      `    indexed ${indexResult.file_count} files / ${indexResult.symbol_count} symbols`,
    );
  }

  const bindings = bridge.getBindings();
  const expectations: Array<[string, unknown, unknown]> = [
    ['project', bindings.project, process.cwd()],
    ['vaultGlobal', bindings.vaultGlobal, '/tmp/fake-vault-just-for-test'],
    ['mode', bindings.mode, 'project+vault'],
    ['shell', bindings.shell, 'bash'],
  ];
  for (const [name, got, want] of expectations) {
    if (got !== want) {
      FAIL(`bindings.${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    console.log(`    bindings.${name}: ${JSON.stringify(got)} ✓`);
  }
  if (!indexResult.error && bindings.indexRequest?.repoPath !== process.cwd()) {
    FAIL(`bindings.indexRequest.repoPath: got ${bindings.indexRequest?.repoPath}, want ${process.cwd()}`);
  }
  console.log(
    `    bindings.indexRequest: ${JSON.stringify(bindings.indexRequest)} ✓`,
  );

  // ── Cleanup ─────────────────────────────────────────────────────────────
  console.log('[5] Shutting down bridge…');
  await bridge.shutdown();

  console.log('');
  console.log('PASS — heartbeat survived 10s exec, bindings populated correctly.');
}

run().catch((err) => {
  console.error('UNHANDLED:', err);
  process.exit(1);
});
