/**
 * Phase 1 — Bridge lifecycle tests.
 *
 * Verifies: start, ping, exec basic, exec error, timeout, reset, shutdown.
 *
 * Run: npx tsx test/repl/bridge.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import type { ReplEvent } from '../../src/repl/types.js';

let pass = 0;
let fail = 0;
const events: ReplEvent[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  const bridge = new ReplBridge({
    timeoutMs: 5_000,
    onEvent: (e) => events.push(e),
  });

  // --- start ---
  await bridge.start();
  check('bridge starts', bridge.isAlive());
  check('bridge_ready emitted', events.some(e => e.type === 'bridge_ready'));

  // --- ping ---
  const pong = await bridge.ping();
  check('ping returns true', pong);

  // --- basic exec ---
  const r1 = await bridge.exec({ code: "print('hello')" });
  check('basic exec stdout', r1.stdout.trim() === 'hello');
  check('basic exec no exception', r1.exception === null);
  check('basic exec not rejected', r1.rejected === null);
  check('basic exec has duration', r1.duration_ms >= 0);

  // --- exec with runtime error ---
  const r2 = await bridge.exec({ code: "x = 1/0" });
  check('div/0 raises', r2.exception !== null && r2.exception.includes('ZeroDivisionError'));

  // --- exec with syntax error ---
  const r3 = await bridge.exec({ code: "print('oops'" });
  check('syntax err rejected', r3.rejected !== null);

  // --- timeout ---
  const r4 = await bridge.exec({ code: "while True: pass", timeout_ms: 1_000 });
  check('infinite loop times out', r4.timed_out === true, `got: ${JSON.stringify(r4).slice(0, 100)}`);
  check('timeout has exception msg', r4.exception !== null && r4.exception.includes('exceeded'));

  // --- reset ---
  await bridge.exec({ code: "x = 42" });
  const r5a = await bridge.exec({ code: "print(x)" });
  check('namespace persists', r5a.stdout.trim() === '42');
  await bridge.reset();
  const r5b = await bridge.exec({ code: "print(x)" });
  check('reset clears namespace', r5b.exception !== null && r5b.exception.includes('NameError'));

  // --- multiple execs ---
  const r6 = await bridge.exec({ code: "print(sum(range(100)))" });
  check('range sum correct', r6.stdout.trim() === '4950');

  // --- shutdown ---
  await bridge.shutdown();
  check('bridge shuts down', !bridge.isAlive());

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
