/**
 * Profile a real "orient" Repl call end-to-end so we can see where the
 * 50s actually lives. Mirrors what Sonnet emits when the user types
 * "orient" — a 2-op batch (vault.orient + vault.query_warmth).
 *
 * Reports per-op wall time so we can decide whether the bottleneck is:
 *   - ori-memory MCP backend (orient/warmth processing on the 988-note vault)
 *   - bridge round-trip overhead
 *   - body exec overhead
 *
 * Run with:  npx tsx bench/recovery/orient-timing.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import { OriVault } from '../../src/memory/vault.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function timeIt<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`  ${label.padEnd(32)} ${ms.toString().padStart(6)}ms`);
  return result;
}

async function run(): Promise<void> {
  const vaultPath = join(homedir(), 'brain');

  const bridge = new ReplBridge({});
  console.log('[1] Bridge start…');
  await timeIt('bridge.start()', () => bridge.start());

  console.log('[2] Bind sequence (matches setup.ts)…');
  await timeIt('configure', () => bridge.configure({
    project: process.cwd(),
    vaultGlobal: vaultPath,
    mode: 'project+vault',
    shell: 'bash',
  }));
  // setVault wires a JS-side OriVault into the bridge so vault_request
  // callbacks from the body proxy actually dispatch somewhere. Without
  // this, the body sees "vault not connected" because the bridge has
  // nothing to route to.
  const oriVault = new OriVault(vaultPath);
  await timeIt('OriVault().connect()', async () => oriVault.connect());
  bridge.setVault(oriVault);
  await timeIt('connectVault (proxy)', () => bridge.connectVault({ vaultPath }));
  // skip index — not relevant to orient timing
  // skip configureRlm — no API key needed for orient

  console.log('[3] Run orient batch (matches Sonnet-emitted ops on "orient"):');
  const op1 = await timeIt('op1: vault.orient(brief=True)', () => bridge.exec({
    code: 'status = vault.orient(brief=True)\nsay(status)',
  }));
  if (op1.exception) console.log(`    op1 exception:\n${op1.exception}`);

  const op2 = await timeIt('op2: vault.query_warmth(...)', () => bridge.exec({
    code: `warm = vault.query_warmth('active projects tasks pending')\nfor n in warm['results'][:4]:\n    say(f"[warm] {n['title']}")`,
  }));
  if (op2.exception) console.log(`    op2 exception:\n${op2.exception}`);

  console.log('[4] Cold cache replay (same calls, second time):');
  await timeIt('op1 (warm)', () => bridge.exec({
    code: 'status = vault.orient(brief=True)\nsay(status)',
  }));
  await timeIt('op2 (warm)', () => bridge.exec({
    code: `warm = vault.query_warmth('active projects tasks pending')\nfor n in warm['results'][:4]:\n    say(f"[warm] {n['title']}")`,
  }));

  await bridge.shutdown();
}

const chr = (n: number) => String.fromCharCode(n);

run().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
