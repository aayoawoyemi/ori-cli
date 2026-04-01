/**
 * Smoke test: verify detection, vault connection, preflight, and project brain.
 * Run: npx tsx test/smoke.ts
 */

import { detectExistingSetup } from '../src/onboarding/detect.js';
import { findVault, OriVault } from '../src/memory/vault.js';
import { ProjectBrain } from '../src/memory/projectBrain.js';
import { runPreflight } from '../src/memory/preflight.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { loadConfig } from '../src/config/load.js';
import type { Message } from '../src/router/types.js';

const cwd = process.cwd();
let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
  return (async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${name}: ${(err as Error).message}`);
      failed++;
    }
  })();
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

console.log('\n🧪 Aries CLI — Smoke Tests\n');

// ── 1. Vault Discovery ──────────────────────────────────────────────────────

console.log('Vault Discovery:');

await test('findVault discovers a vault', () => {
  const path = findVault();
  console.log(`    Found: ${path}`);
  assert(path !== null, 'No vault found. Expected ~/brain or similar.');
});

await test('detectExistingSetup finds vault', () => {
  const result = detectExistingSetup(cwd);
  assert(result.hasVault, 'hasVault should be true');
  assert(result.vaultPath !== null, 'vaultPath should not be null');
  assert(!result.isFirstRun, 'isFirstRun should be false when vault exists');
  console.log(`    Vault: ${result.vaultPath}`);
  console.log(`    First run: ${result.isFirstRun}`);
});

// ── 2. Vault Connection ─────────────────────────────────────────────────────

console.log('\nVault Connection:');

const vaultPath = findVault();
let vault: OriVault | null = null;

if (vaultPath) {
  await test('OriVault connects via MCP', async () => {
    vault = new OriVault(vaultPath);
    await vault.connect();
    assert(vault.connected, 'Vault should be connected');
  });

  await test('vault.status() returns note count', async () => {
    assert(vault !== null, 'Vault not connected');
    const status = await vault!.status();
    assert(status !== null, 'Status should not be null');
    assert(typeof status!.noteCount === 'number', 'noteCount should be a number');
    console.log(`    Notes: ${status!.noteCount}`);
  });

  await test('vault.loadIdentity() loads self/ files', async () => {
    assert(vault !== null, 'Vault not connected');
    const identity = await vault!.loadIdentity();
    console.log(`    Identity: ${identity.identity ? identity.identity.slice(0, 60) + '...' : 'null'}`);
    console.log(`    Goals: ${identity.goals ? 'loaded' : 'null'}`);
    console.log(`    User model: ${identity.userModel ? 'loaded' : 'null'}`);
  });

  await test('vault.queryRanked() returns results', async () => {
    assert(vault !== null, 'Vault not connected');
    const results = await vault!.queryRanked('memory architecture for agents', 3);
    console.log(`    Results: ${results.length}`);
    for (const r of results) {
      console.log(`    - "${r.title}" (${r.score?.toFixed(3)})`);
    }
  });

  await test('vault.queryWarmth() returns results', async () => {
    assert(vault !== null, 'Vault not connected');
    const results = await vault!.queryWarmth('building a CLI tool with persistent memory', 3);
    console.log(`    Results: ${results.length}`);
    for (const r of results) {
      console.log(`    - "${r.title}" (${r.score?.toFixed(3)})`);
    }
  });

  await test('vault.queryImportant() returns results', async () => {
    assert(vault !== null, 'Vault not connected');
    const results = await vault!.queryImportant(3);
    console.log(`    Results: ${results.length}`);
    for (const r of results) {
      console.log(`    - "${r.title}" (${r.score?.toFixed(3)})`);
    }
  });
} else {
  console.log('  ⚠ No vault found — skipping vault tests');
}

// ── 3. Project Brain ────────────────────────────────────────────────────────

console.log('\nProject Brain:');

await test('ProjectBrain initializes and loads', () => {
  const brain = new ProjectBrain(cwd);
  brain.init();
  brain.load();
  console.log(`    Memories: ${brain.count}`);
});

await test('ProjectBrain.save() and search()', () => {
  const brain = new ProjectBrain(cwd);
  brain.init();
  brain.save('test memory for smoke test', 'This is a test memory to verify project brain works.', 'learning');
  brain.load();
  assert(brain.count > 0, 'Should have at least 1 memory after save');

  const results = brain.search('smoke test');
  assert(results.length > 0, 'Should find the test memory');
  console.log(`    Saved and found: "${results[0].title}"`);
});

// ── 4. Preflight ────────────────────────────────────────────────────────────

console.log('\nPreflight:');

await test('runPreflight returns context from vault + brain', async () => {
  const brain = new ProjectBrain(cwd);
  brain.init();
  brain.load();

  const messages: Message[] = [
    { role: 'user', content: 'How should I structure persistent memory for a coding agent?' },
  ];

  const result = await runPreflight(messages, brain, vault);
  if (result) {
    console.log(`    Project notes: ${result.projectNotes.length}`);
    console.log(`    Vault notes: ${result.vaultNotes.length}`);
    console.log(`    Context block: ${result.contextBlock.length} chars`);
  } else {
    console.log(`    No preflight context (may be expected if vault is empty)`);
  }
});

// ── 5. System Prompt ────────────────────────────────────────────────────────

console.log('\nSystem Prompt:');

await test('buildSystemPrompt includes vault identity', async () => {
  const config = loadConfig(cwd);
  const vaultIdentity = vault ? await vault.loadIdentity() : null;

  const prompt = buildSystemPrompt({
    cwd,
    config,
    vaultPath: vaultPath ?? undefined,
    vaultNoteCount: 576,
    projectBrainCount: 5,
    vaultIdentity,
  });

  assert(prompt.length > 500, 'Prompt should be substantial');
  assert(prompt.includes('Operational Rules'), 'Should contain operational rules');
  console.log(`    Prompt length: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  console.log(`    Has vault identity: ${prompt.includes('identity') || prompt.includes('Aries')}`);
});

// ── Cleanup ─────────────────────────────────────────────────────────────────

vault?.disconnect();

// Clean up test memory
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
try {
  unlinkSync(join(cwd, '.aries', 'memory', 'test-memory-for-smoke-test.md'));
} catch { /* already cleaned */ }

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
