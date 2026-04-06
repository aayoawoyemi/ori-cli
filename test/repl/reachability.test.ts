/**
 * Phase 2.5 — Reachability bridge test.
 *
 * Simulates the /index + /repl flow that a user would execute via slash commands.
 * Does NOT spin up the Ink UI, but exercises exactly the same code path:
 *   - setupReplBridge (index.ts wiring)
 *   - bridge.index + exec (app.tsx /index + /repl handlers)
 *   - hook invocation (app.tsx runHooks calls)
 *   - session logging (storage.ts code_execution entry)
 *
 * Run: npx tsx test/repl/reachability.test.ts
 */
import { setupReplBridge } from '../../src/repl/setup.js';
import { runHooks } from '../../src/hooks/runner.js';
import { SessionStorage, type SessionEntry } from '../../src/session/storage.js';
import { readFileSync } from 'node:fs';
import type { ReplConfig, HooksConfig } from '../../src/config/types.js';

const REPL_CONFIG: ReplConfig = {
  enabled: true,
  timeoutMs: 10_000,
  maxIterations: 1000,
  maxRlmCalls: 10,
  sandbox: 'same_process',
  maxRestarts: 2,
};

const EMPTY_HOOKS: HooksConfig = {};

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
  // ---- setup (mirrors index.ts boot path) ----
  const handle = await setupReplBridge({
    config: REPL_CONFIG,
    cwd: process.cwd(),
  });
  if (!handle) {
    console.log('FAIL: bridge did not start');
    process.exit(1);
  }
  check('bridge started via setup helper', handle.isAlive());

  // ---- session (mirrors index.ts session construction) ----
  const session = new SessionStorage(process.cwd());

  // ---- /index flow (from app.tsx) ----
  const indexResult = await handle.bridge.index({ repoPath: 'src' });
  check('/index succeeds', indexResult.ok === true);
  check('/index produces edges', indexResult.edge_count > 50);

  // ---- /repl flow (from app.tsx) ----
  const code = "print(codebase.stats())";

  // preCodeExecution hook (would block if configured; empty hooks = no-op)
  const preResult = await runHooks(
    'preCodeExecution',
    EMPTY_HOOKS,
    { cwd: process.cwd() },
    undefined,
    { code },
  );
  check('preCodeExecution hook runs without blocking', !preResult.blocked);

  // Execute
  const execResult = await handle.exec({ code });
  check('/repl exec succeeds', execResult.exception === null);
  check('/repl output contains stats', execResult.stdout.includes('schema_version'));

  // Log to session (mirrors app.tsx session.log)
  session.log({
    type: 'code_execution',
    code,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    exception: execResult.exception,
    duration_ms: execResult.duration_ms,
    rejected: execResult.rejected,
    timed_out: execResult.timed_out,
    timestamp: Date.now(),
  });

  // postCodeExecution hook
  await runHooks(
    'postCodeExecution',
    EMPTY_HOOKS,
    { cwd: process.cwd() },
    undefined,
    {
      code,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exception: execResult.exception,
      rejected: execResult.rejected,
    },
  );

  // ---- Verify session entry was persisted ----
  const entries: SessionEntry[] = SessionStorage.readSession(session.path);
  const codeEntry = entries.find(e => e.type === 'code_execution');
  check('session persisted code_execution entry', codeEntry !== undefined);
  if (codeEntry && codeEntry.type === 'code_execution') {
    check('session entry has correct code', codeEntry.code === code);
    check('session entry has schema_version in stdout', codeEntry.stdout.includes('schema_version'));
  }

  // ---- Rejection path ----
  const badCode = "import os";
  const rejectResult = await handle.exec({ code: badCode });
  check('dangerous code rejected', rejectResult.rejected !== null);

  // ---- Composition: full search → cluster → context (the spike pattern) ----
  const composition = `
matches = codebase.search("permission", limit=30)
clusters = codebase.cluster_by_file(matches)
print(f"clusters={len(clusters)}")
for f in list(clusters.keys())[:3]:
    print(f"  {f}: {len(clusters[f])} hits")
`;
  const compositionResult = await handle.exec({ code: composition });
  check('composition pattern executes', compositionResult.exception === null);
  check('composition finds permission matches', compositionResult.stdout.includes('clusters='));

  // ---- Verify trajectory log has entries ----
  // (setupReplBridge auto-creates trajectory logger; each exec writes one entry)
  // We don't check contents here since the logger is opaque — just verify exec succeeds.

  await handle.shutdown();
  check('bridge shuts down cleanly', !handle.isAlive());

  console.log('');
  console.log(`${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
