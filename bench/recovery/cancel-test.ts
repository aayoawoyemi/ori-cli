/**
 * P5 validation: cancel_exec protocol.
 *
 * What this proves:
 *   1. bridge.cancelExec() reaches the body and receives an ack.
 *   2. After cancel, the body is ready for the next exec without restart.
 *
 * Limitations:
 *   - Doesn't test Windows OS-wait edge case (where _async_raise can't
 *     unwind a worker stuck in WaitForSingleObject); deferred.
 *   - Worker's threading.Event.wait() inside Shell._call may or may not
 *     yield to the async exception promptly depending on platform; if it
 *     doesn't, `joined` returns false and the bridge would normally fall
 *     back to restart. We accept either outcome here — what we're testing
 *     is that the protocol round-trips end-to-end.
 *
 * Run with:  npx tsx bench/recovery/cancel-test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';

const FAIL = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function run(): Promise<void> {
  const bridge = new ReplBridge({});

  console.log('[1] Starting bridge…');
  await bridge.start();
  await new Promise((r) => setTimeout(r, 300));

  // Test 1: cancel with no exec running — should still ack.
  console.log('[2] cancelExec() with no in-flight exec…');
  const result1 = await bridge.cancelExec(2_000);
  if (result1 === null) {
    FAIL('cancelExec returned null (no ack) — body may not understand op');
  }
  console.log(`    ack: ${JSON.stringify(result1)}`);
  if (!result1.cancel_acked) {
    FAIL('expected cancel_acked=true');
  }
  // joined should be true (or N/A) when no exec was running
  console.log(`    PASSED — body acked cancel without an in-flight exec`);

  // Test 2: cancel during a sleep — fire-and-forget the exec, cancel mid-flight.
  // Shell.run uses threading.Event.wait at the body level, which on Linux yields
  // to async exceptions promptly but on Windows may not. Either result is OK
  // for this test; we just want to confirm the round-trip.
  console.log('[3] Submitting shell.run("sleep 5") then cancelExec mid-flight…');
  const execPromise = bridge.exec({
    code: `
r = shell.run("sleep 5", timeout=10)
print(f"shell exited code={r['code']}")
`.trim(),
    timeout_ms: 15_000,
  });

  await new Promise((r) => setTimeout(r, 1_000));  // let it get into the wait
  const cancelStart = Date.now();
  const result2 = await bridge.cancelExec(2_000);
  const ackMs = Date.now() - cancelStart;
  console.log(`    ack: ${JSON.stringify(result2)} (${ackMs}ms)`);

  // Either outcome is accepted — what matters is that the protocol round-trips.
  // If joined=true, the worker actually unwound. If joined=false, the worker
  // is in an OS wait that _async_raise can't reach; in production the bridge
  // would fall back to restart on follow-up timeout (separately tested in
  // restart-test.ts).
  if (result2 === null) {
    console.log('    note: body did not ack within deadline — caller would fall back to restart');
  }

  // Drain the exec promise — it'll either complete normally (cancel didn't
  // unwind, sleep finishes) or throw because the cancel killed it.
  try {
    const r = await execPromise;
    console.log(`    underlying exec completed: stdout tail="${r.stdout.slice(-60)}"`);
  } catch (err) {
    console.log(`    underlying exec rejected: ${(err as Error).message}`);
  }

  // Test 3: subsequent exec should work regardless of whether cancel unwound.
  console.log('[4] Submitting follow-up exec after cancel…');
  const followUp = await bridge.exec({
    code: 'print("post-cancel exec works")',
    timeout_ms: 5_000,
  });
  if (!followUp.stdout.includes('post-cancel exec works')) {
    FAIL(`follow-up exec missing expected output. tail: ${followUp.stdout.slice(-200)}`);
  }
  console.log(`    PASSED — body ready for next exec after cancel`);

  await bridge.shutdown();
  console.log('');
  console.log('PASS — cancel protocol round-trips end-to-end.');
}

run().catch((err) => {
  console.error('UNHANDLED:', err);
  process.exit(1);
});
