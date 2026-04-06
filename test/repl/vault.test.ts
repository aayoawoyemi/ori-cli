/**
 * Phase 3 — Vault body tests.
 *
 * Requires: `ori` CLI on PATH, and a vault at $HOME/brain (or ORI_TEST_VAULT env).
 *
 * Run: npx tsx test/repl/vault.test.ts
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
    console.log(`  SKIP: no vault at ${VAULT_PATH}. Set ORI_TEST_VAULT env to test.`);
    process.exit(0);
  }

  const bridge = new ReplBridge({ timeoutMs: 30_000 });
  await bridge.start();

  // ---- Before connecting: vault should NOT be in namespace ----
  const r0 = await bridge.exec({ code: 'print(vault)' });
  check('vault undefined before connect',
    r0.exception !== null && r0.exception.includes('NameError'));

  // ---- Connect vault ----
  const connectResult = await bridge.connectVault({ vaultPath: VAULT_PATH });
  check('connect_vault ok', connectResult.ok === true);
  check('connect_vault reports notes', (connectResult.note_count ?? 0) > 0,
    `notes: ${connectResult.note_count}`);

  // ---- vault_status via API ----
  const status = await bridge.vaultStatus();
  check('vault_status succeeds', !status.error);
  check('vault_status has noteCount', (status.noteCount ?? 0) > 0);

  // ---- vault.status() via REPL ----
  const r1 = await bridge.exec({
    code: 'print(vault.status())',
  });
  check('vault.status() in REPL',
    r1.exception === null && r1.stdout.includes('noteCount'),
    r1.exception?.slice(0, 80) ?? r1.rejected?.reason);

  // ---- vault.query_ranked() ----
  const r2 = await bridge.exec({
    code: `
result = vault.query_ranked("REPL composition", limit=3)
if isinstance(result, dict) and "results" in result:
    for entry in result["results"]:
        print(f"  {entry.get('title', '?')[:80]}")
print(f"count: {len(result.get('results', []))}")
`,
  });
  check('vault.query_ranked runs', r2.exception === null, r2.exception?.slice(0, 80));
  check('vault.query_ranked returns results', r2.stdout.includes('count:'));

  // ---- vault.query_important() ----
  const r3 = await bridge.exec({
    code: `
result = vault.query_important(limit=3)
titles = [r.get("title", "?") for r in result.get("results", [])]
print(f"top 3: {titles}")
`,
  });
  check('vault.query_important runs', r3.exception === null);

  // ---- Composition: codebase + vault together ----
  // Index codebase first
  const idxResult = await bridge.index({ repoPath: 'src' });
  check('codebase indexed alongside vault', idxResult.ok === true);

  const r4 = await bridge.exec({
    code: `
# Both substrates available simultaneously
cb_stats = codebase.stats()
v_status = vault.status()
print(f"codebase: {cb_stats['file_count']} files")
print(f"vault: {v_status.get('noteCount', '?')} notes")
print("both substrates live")
`,
  });
  check('codebase + vault in same REPL', r4.exception === null && r4.stdout.includes('both substrates live'));

  // ---- Composition that touches both ----
  const r5 = await bridge.exec({
    code: `
# Find a codebase concept, query vault for related thinking
matches = codebase.search("warm context", limit=10)
if matches:
    concept = "warm context"
    vault_hits = vault.query_ranked(concept, limit=3)
    print(f"codebase matches: {len(matches)}")
    print(f"vault results:")
    for entry in vault_hits.get("results", [])[:3]:
        print(f"  {entry.get('title', '?')[:80]}")
`,
  });
  check('cross-substrate composition', r5.exception === null);

  // ---- Disconnect vault ----
  const disc = await bridge.disconnectVault();
  check('disconnect_vault ok', disc.ok === true);

  // After disconnect, vault should be gone from namespace
  const r6 = await bridge.exec({ code: 'print(vault)' });
  check('vault removed from namespace after disconnect',
    r6.exception !== null && r6.exception.includes('NameError'));

  await bridge.shutdown();

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
