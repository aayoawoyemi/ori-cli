/**
 * Phase 1 E2E — setup helper, trajectory logging, full lifecycle.
 *
 * Run: npx tsx test/repl/e2e.test.ts
 */
import { setupReplBridge } from '../../src/repl/setup.js';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReplConfig } from '../../src/config/types.js';

const TEST_TRACE = resolve(process.cwd(), '.aries', 'repl-traces', 'e2e-test.jsonl');

const CONFIG: ReplConfig = {
  enabled: true,
  timeoutMs: 5_000,
  maxIterations: 1000,
  maxRlmCalls: 10,
  sandbox: 'same_process',
  maxRestarts: 3,
};

async function main() {
  // Clean up prior test trace
  if (existsSync(TEST_TRACE)) rmSync(TEST_TRACE);

  // --- enabled=false returns null ---
  const disabled = await setupReplBridge({
    config: { ...CONFIG, enabled: false },
    cwd: process.cwd(),
  });
  if (disabled !== null) {
    console.log('FAIL: disabled config should return null');
    process.exit(1);
  }
  console.log('  ✓ disabled config returns null');

  // --- enabled=true spawns bridge ---
  const handle = await setupReplBridge({
    config: CONFIG,
    cwd: process.cwd(),
    trajectoryPath: TEST_TRACE,
  });
  if (!handle) {
    console.log('FAIL: enabled config returned null');
    process.exit(1);
  }
  console.log('  ✓ enabled config spawned bridge');

  if (!handle.isAlive()) {
    console.log('FAIL: bridge not alive after setup');
    process.exit(1);
  }
  console.log('  ✓ bridge is alive');

  // --- exec runs through handle.exec ---
  const r1 = await handle.exec({
    code: "print('e2e: hello')",
    turn_id: 'turn-1',
  });
  if (r1.stdout.trim() !== 'e2e: hello') {
    console.log('FAIL: exec stdout wrong:', r1.stdout);
    process.exit(1);
  }
  console.log('  ✓ exec produces expected stdout');

  // --- trajectory logged ---
  const r2 = await handle.exec({
    code: "print(sum(range(10)))",
    turn_id: 'turn-2',
  });
  if (r2.stdout.trim() !== '45') {
    console.log('FAIL: sum wrong');
    process.exit(1);
  }

  if (!existsSync(TEST_TRACE)) {
    console.log('FAIL: trajectory file not created');
    process.exit(1);
  }
  console.log('  ✓ trajectory file created');

  const lines = readFileSync(TEST_TRACE, 'utf-8').trim().split('\n');
  if (lines.length !== 2) {
    console.log(`FAIL: expected 2 trajectory entries, got ${lines.length}`);
    process.exit(1);
  }
  console.log('  ✓ trajectory has 2 entries');

  const entry1 = JSON.parse(lines[0]);
  if (entry1.turn_id !== 'turn-1' || entry1.stdout.trim() !== 'e2e: hello') {
    console.log('FAIL: first trajectory entry wrong:', entry1);
    process.exit(1);
  }
  console.log('  ✓ trajectory entries have correct fields');

  // --- rejected execution logged with rejected field ---
  const r3 = await handle.exec({
    code: "import os",
    turn_id: 'turn-3',
  });
  if (!r3.rejected) {
    console.log('FAIL: import not rejected');
    process.exit(1);
  }
  console.log('  ✓ import rejected at AST layer');

  const lines2 = readFileSync(TEST_TRACE, 'utf-8').trim().split('\n');
  if (lines2.length !== 3) {
    console.log('FAIL: rejection not logged');
    process.exit(1);
  }
  const entry3 = JSON.parse(lines2[2]);
  if (!entry3.rejected) {
    console.log('FAIL: rejected field missing in log');
    process.exit(1);
  }
  console.log('  ✓ rejection logged with rejected field');

  // --- shutdown ---
  await handle.shutdown();
  if (handle.isAlive()) {
    console.log('FAIL: bridge alive after shutdown');
    process.exit(1);
  }
  console.log('  ✓ shutdown clean');

  console.log('');
  console.log('PASS: e2e lifecycle + trajectory logging works');
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
