/**
 * P3 + P4 validation: heartbeat-driven restart with state replay, and
 * removal of per-request bridge timeouts.
 *
 * What this proves:
 *   1. (P4) A 30s shell.run completes normally with NO bridge timeout.
 *      Pre-P4 the exec hit the 120s outer ceiling and rejected; post-P4
 *      the bridge waits indefinitely on the body's response.
 *   2. (P3) When the body's main loop is forced into a wedge (via the
 *      ARIES_DEVKIT=1 __test_wedge_main_loop op), the heartbeat detects
 *      it within ~5s, fires bridge_unhealthy, the bridge restarts the
 *      body silently, replays bound state via onRestart, and emits
 *      bridge_recovered. A subsequent exec on the new body works.
 *   3. (P3) Pending requests in flight when the wedge fires reject with
 *      BodyRestartedError, which the Repl tool can catch.
 *
 * Run with:  npx tsx bench/recovery/restart-test.ts
 *
 * Note: this test sets ARIES_DEVKIT=1 in process.env so the body picks
 * up the dev op when spawned. Production bodies never see this op.
 */
process.env.ARIES_DEVKIT = '1';

import { ReplBridge, BodyRestartedError } from '../../src/repl/bridge.js';
import type { ReplEvent } from '../../src/repl/types.js';

const FAIL = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function run(): Promise<void> {
  const events: ReplEvent[] = [];
  let unhealthyAt: number | null = null;
  let recoveredAt: number | null = null;
  let restartReason: string | null = null;
  let onRestartCallCount = 0;
  let lastReplayMs: number | null = null;

  const bridge = new ReplBridge({
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'bridge_unhealthy') unhealthyAt = Date.now();
      if (e.type === 'bridge_recovered') {
        recoveredAt = Date.now();
        lastReplayMs = e.replayMs;
      }
      if (e.type === 'bridge_restart') restartReason = e.reason;
    },
    onRestart: async () => {
      // Real production setup.ts onRestart calls configure → index → vault
      // → rlm → research. For this test we just bump the counter to prove
      // restart-with-replay actually invoked the callback. Bridge.exec
      // works fine without a real index in the test scenario.
      onRestartCallCount++;
    },
  });

  // ── Test 1: long shell.run completes without bridge timeout (P4) ────────
  console.log('[1] Starting bridge…');
  await bridge.start();
  await new Promise((r) => setTimeout(r, 300));

  console.log('[2] Submitting Repl with shell.run("sleep 30")…');
  console.log('    (pre-P4 this would reject at 120s with bridge timeout;');
  console.log('     post-P4 the bridge waits indefinitely on the body)');
  const longExecStart = Date.now();
  const longExecResult = await bridge.exec({
    code: `
r = shell.run("sleep 30", timeout=35)
print(f"shell exited code={r['code']}")
`.trim(),
    timeout_ms: 40_000,
  });
  const longExecDur = Date.now() - longExecStart;

  if (longExecResult.exception) {
    FAIL(`P4 test: exec raised: ${longExecResult.exception}`);
  }
  if (!longExecResult.stdout.includes('shell exited code=0')) {
    FAIL(`P4 test: expected shell to exit 0; tail: ${longExecResult.stdout.slice(-200)}`);
  }
  if (longExecDur < 28_000) {
    FAIL(`P4 test: returned in ${longExecDur}ms — sleep didn't actually sleep 30s`);
  }
  console.log(`    PASSED — completed in ${longExecDur}ms (no bridge ceiling)`);

  // ── Test 2: heartbeat detects wedge → silent restart with replay (P3) ──
  console.log('');
  console.log('[3] Forcing main-loop wedge via __test_wedge_main_loop…');
  console.log('    (heartbeat should detect within ~5s and fire restart)');
  const wedgeStart = Date.now();

  // Submit a Repl AFTER firing the wedge so we have a pending in-flight
  // request to verify drainPendingAsRestart triggers BodyRestartedError.
  // The wedge op itself is fire-and-forget — we don't await it because
  // it'll never respond. We just write directly to stdin via reflection
  // since wedge isn't a public bridge method.
  // Simpler: use an exec that calls the wedge through code. But the wedge
  // is at the SERVER level, not exec level. Instead, construct a raw
  // request via the bridge's internal channel.
  //
  // Cleanest: use the bridge's index() (which routes through public
  // request()) right after a custom raw write of __test_wedge_main_loop.
  // Even cleaner: add a public force-wedge method in tests-only mode.
  // Cheapest: write directly to the body's stdin via internal access.
  //
  // We DO have a way: bridge has process.write() public on ReplProcess
  // but the bridge doesn't expose process. So we use a private workaround
  // — eval-time access to (bridge as any).process. Acceptable in test code.
  const proc = (bridge as unknown as { process: { write(s: string): boolean } }).process;
  proc.write(JSON.stringify({ op: '__test_wedge_main_loop', seconds: 60 }));
  // Give the body a moment to enter the wedge so the next request actually
  // hits a wedged main loop (otherwise the next request might race ahead
  // and complete before the wedge starts).
  await new Promise((r) => setTimeout(r, 200));

  // Submit an exec that will queue at the bridge; main loop is now
  // wedged so even pings won't get through. Heartbeat should fire
  // unhealthy in ~3 misses × 1.5s deadline = 4.5s after the last good pong.
  // The exec promise should reject with BodyRestartedError when restart
  // fires and drainPendingAsRestart runs.
  const wedgeExecPromise = bridge.exec({
    code: 'print("should never run")',
    timeout_ms: 30_000,
  });

  let restartErrorCaught = false;
  let restartErrorReason: string | null = null;
  try {
    await wedgeExecPromise;
  } catch (err) {
    if (err instanceof BodyRestartedError) {
      restartErrorCaught = true;
      restartErrorReason = err.restartReason;
    } else {
      FAIL(`expected BodyRestartedError, got ${(err as Error).name}: ${(err as Error).message}`);
    }
  }

  if (!restartErrorCaught) {
    FAIL(`P3 test: wedge exec did not throw BodyRestartedError`);
  }
  console.log(`    BodyRestartedError caught — reason: "${restartErrorReason}"`);

  // Wait for bridge_recovered to fire (restart + replay complete).
  const recoveryDeadline = Date.now() + 10_000;
  while (recoveredAt === null && Date.now() < recoveryDeadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (recoveredAt === null) {
    FAIL(`P3 test: bridge_recovered never fired within 10s of wedge start`);
  }

  const detectMs = unhealthyAt! - wedgeStart;
  const recoverMs = recoveredAt - wedgeStart;
  console.log(`    heartbeat detected wedge at +${detectMs}ms`);
  console.log(`    bridge_recovered at +${recoverMs}ms (replay=${lastReplayMs}ms)`);
  console.log(`    restart reason: "${restartReason}"`);
  console.log(`    onRestart callback invoked ${onRestartCallCount}× ✓`);

  if (onRestartCallCount !== 1) {
    FAIL(`P3 test: expected onRestart called exactly 1×, got ${onRestartCallCount}`);
  }
  if (detectMs > 6_000) {
    FAIL(`P3 test: detection took ${detectMs}ms — heartbeat is too slow (target < 6s)`);
  }

  // ── Test 3: subsequent exec works on the recovered body (P3) ──────────
  console.log('');
  console.log('[4] Submitting follow-up exec on recovered body…');
  const followUpResult = await bridge.exec({
    code: 'print("recovered body alive")',
    timeout_ms: 5_000,
  });
  if (followUpResult.exception) {
    FAIL(`follow-up exec raised: ${followUpResult.exception}`);
  }
  if (!followUpResult.stdout.includes('recovered body alive')) {
    FAIL(`follow-up exec stdout missing expected output`);
  }
  console.log(`    PASSED — recovered body executes normally`);

  console.log('');
  console.log('[5] Shutting down bridge…');
  await bridge.shutdown();

  console.log('');
  console.log('PASS — P3 (heartbeat→restart→replay) and P4 (no bridge ceiling) both work.');
}

run().catch((err) => {
  console.error('UNHANDLED:', err);
  process.exit(1);
});
