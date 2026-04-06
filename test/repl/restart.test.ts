/**
 * Phase 1 — Restart-on-crash test.
 *
 * Simulates subprocess crash by forcing a SIGKILL, then verifies the bridge
 * recovers on the next exec.
 *
 * Run: npx tsx test/repl/restart.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import type { ReplEvent } from '../../src/repl/types.js';

const events: ReplEvent[] = [];

async function main() {
  const bridge = new ReplBridge({
    timeoutMs: 5_000,
    maxRestarts: 2,
    onEvent: (e) => events.push(e),
  });

  await bridge.start();
  console.log('  ✓ bridge started');

  // Normal exec
  const r1 = await bridge.exec({ code: "print('before crash')" });
  if (r1.stdout.trim() !== 'before crash') {
    console.log('  FAIL: basic exec broken');
    process.exit(1);
  }
  console.log('  ✓ pre-crash exec ok');

  // Simulate crash: access the underlying process and kill it
  // (This is a test-only intrusion; production code doesn't reach in.)
  const proc = (bridge as any).process;
  if (proc) {
    proc.kill('SIGKILL');
    console.log('  ✓ simulated crash (SIGKILL)');
  }

  // Give the exit event time to fire
  await new Promise((r) => setTimeout(r, 500));

  // Next exec should trigger restart
  let r2;
  try {
    r2 = await bridge.exec({ code: "print('after restart')" });
  } catch (e) {
    console.log('  FAIL: exec after crash threw:', e);
    process.exit(1);
  }

  if (r2.stdout.trim() !== 'after restart') {
    console.log('  FAIL: post-restart exec gave wrong output:', r2.stdout);
    process.exit(1);
  }
  console.log('  ✓ post-restart exec ok');

  const restartEvents = events.filter((e) => e.type === 'bridge_restart');
  if (restartEvents.length < 1) {
    console.log('  FAIL: no bridge_restart event emitted');
    process.exit(1);
  }
  console.log(`  ✓ bridge_restart emitted (${restartEvents.length}x)`);

  if (bridge.getRestartCount() < 1) {
    console.log('  FAIL: restart count not incremented');
    process.exit(1);
  }
  console.log(`  ✓ restart count = ${bridge.getRestartCount()}`);

  await bridge.shutdown();
  console.log('  ✓ shutdown after restart ok');

  console.log('');
  console.log('PASS: restart-on-crash works');
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
