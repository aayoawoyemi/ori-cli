/**
 * Phase 6 — Vault ambient signature tests.
 *
 * Requires a vault at $HOME/brain. Skips if missing.
 *
 * Run: npx tsx test/repl/vault-signature.test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const VAULT_PATH = process.env.ORI_TEST_VAULT ?? resolve(homedir(), 'brain');

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

async function main() {
  if (!existsSync(VAULT_PATH)) {
    console.log(`  SKIP: no vault at ${VAULT_PATH}`);
    process.exit(0);
  }

  const bridge = new ReplBridge({ timeoutMs: 60_000 });
  await bridge.start();

  // ---- Before vault connect: signature fails cleanly ----
  const r0 = await bridge.vaultSignature('standard', 1500);
  check('vault_signature errors before connect',
    r0.error !== undefined && r0.error.includes('not connected'));

  // ---- Connect ----
  const conn = await bridge.connectVault({ vaultPath: VAULT_PATH });
  check('vault connects', conn.ok === true);

  // ---- Generate signature ----
  const sig = await bridge.vaultSignature('standard', 1500);
  check('signature generated', !sig.error);
  check('has schema_version', sig.schema_version === '0.1.0');
  check('has level', sig.level === 'standard');
  check('under token budget', sig.approx_tokens < 1600,
    `${sig.approx_tokens} tokens`);
  check('markdown present', sig.markdown.length > 50);
  check('stats has note_count', (sig.stats.note_count ?? 0) > 0);

  // ---- Content sections ----
  check('has authority_notes', sig.authority_notes.length > 0);
  check('authority has titles', sig.authority_notes[0].title.length > 0);

  // ---- Level progression ----
  const lean = await bridge.vaultSignature('lean', 10_000);
  const std = await bridge.vaultSignature('standard', 10_000);
  const deep = await bridge.vaultSignature('deep', 10_000);
  const max = await bridge.vaultSignature('max', 10_000);

  check('lean ≤ standard tokens',
    lean.approx_tokens <= std.approx_tokens,
    `${lean.approx_tokens} vs ${std.approx_tokens}`);
  check('standard ≤ deep tokens',
    std.approx_tokens <= deep.approx_tokens,
    `${std.approx_tokens} vs ${deep.approx_tokens}`);
  check('deep ≤ max tokens',
    deep.approx_tokens <= max.approx_tokens,
    `${deep.approx_tokens} vs ${max.approx_tokens}`);

  check('max has more authority_notes than lean',
    max.authority_notes.length > lean.authority_notes.length);
  check('deep has fading_notes (lean does not)',
    deep.fading_notes.length > 0 || lean.fading_notes.length === 0);

  // ---- Budget enforcement ----
  const tiny = await bridge.vaultSignature('deep', 300);
  check('tight budget respected', tiny.approx_tokens < 350,
    `${tiny.approx_tokens} tokens at 300 target`);

  // ---- Two signatures at once (cross-substrate) ----
  await bridge.index({ repoPath: 'src' });
  const codeSig = await bridge.codebaseSignature('standard', 1500);
  const vaultSig = await bridge.vaultSignature('standard', 1500);
  const totalTokens = codeSig.approx_tokens + vaultSig.approx_tokens;
  check('both signatures together fit in budget',
    totalTokens < 3000,
    `codebase: ${codeSig.approx_tokens} + vault: ${vaultSig.approx_tokens} = ${totalTokens}`);

  await bridge.disconnectVault();
  await bridge.shutdown();

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  if (fail === 0) {
    console.log('');
    console.log('--- Sample vault signature (standard) ---');
    console.log(sig.markdown.slice(0, 500));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
