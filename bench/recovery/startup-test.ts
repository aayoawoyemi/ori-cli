/**
 * Startup-sequence regression test for the heartbeat-during-bind bug.
 *
 * Repro of user's issue (2026-04-28):
 *   rlm: OpenRouter · openai/gpt-oss-20b
 *   [repl] bridge_restart: heartbeat: body unresponsive (attempt 1)
 *   [repl] bridge_error: rlm_call config exception: body restarted: heartbeat: body unresponsive
 *
 * Diagnosis: setupReplBridge calls a sequence of bind ops at startup
 * (configure → index → connectVault → configureRlm → connectResearch).
 * Slow ops (index in particular) ran inline in body's main loop via
 * handle_sync, blocking it for the duration. Pings sat unread in stdin;
 * heartbeat fired spuriously; restart dropped the in-flight bind op.
 *
 * Fix: body's main loop now runs all top-level ops (except exec and
 * shutdown) in a worker thread. Pings keep responding because the main
 * loop returns to the for-line iterator immediately after spawning the
 * thread. This test confirms the fix by running the same bind sequence
 * and asserting no heartbeat unhealthy event fires.
 *
 * Run with:  npx tsx bench/recovery/startup-test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import type { ReplEvent } from '../../src/repl/types.js';

const FAIL = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

async function run(): Promise<void> {
  const events: ReplEvent[] = [];
  const bridge = new ReplBridge({
    onEvent: (e) => events.push(e),
  });

  console.log('[1] Starting bridge…');
  await bridge.start();
  await new Promise((r) => setTimeout(r, 200));

  // Mirror setup.ts startup sequence as closely as possible without the
  // real vault/rlm credentials. The slow op is index — that's the one
  // that pre-fix would block main loop and trigger the spurious heartbeat.
  console.log('[2] Running bind sequence: configure → index → configureRlm…');
  const startMs = Date.now();

  await bridge.configure({
    project: process.cwd(),
    mode: 'project+vault',
    shell: 'bash',
  });
  console.log(`    configure done at +${Date.now() - startMs}ms`);

  const indexResult = await bridge.index({ repoPath: process.cwd() });
  console.log(
    `    index done at +${Date.now() - startMs}ms ` +
      `(${indexResult.file_count} files / ${indexResult.symbol_count} symbols)`,
  );

  // Use a dummy api key — configureRlm in the body just stores the
  // credentials, doesn't actually validate against any provider, so a
  // dummy key works for testing the bind protocol round-trip.
  await bridge.configureRlm({
    apiKey: 'sk-test-dummy-key-for-startup-test',
    model: 'openai/gpt-oss-20b',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  console.log(`    configureRlm done at +${Date.now() - startMs}ms`);

  // ── Assertion: no spurious heartbeat unhealthy fired during startup ───
  const unhealthyEvents = events.filter((e) => e.type === 'bridge_unhealthy');
  const restartEvents = events.filter((e) => e.type === 'bridge_restart');
  console.log('');
  console.log('[3] Verifying no spurious heartbeat events fired…');
  console.log(`    bridge_unhealthy events: ${unhealthyEvents.length}`);
  console.log(`    bridge_restart events: ${restartEvents.length}`);

  if (unhealthyEvents.length > 0) {
    FAIL(
      `bridge_unhealthy fired ${unhealthyEvents.length}× during normal ` +
        `startup — heartbeat thinks body is wedged when it's just doing ` +
        `slow bind ops. The body's main loop must run handle_sync ops in ` +
        `worker threads so pings keep responding.`,
    );
  }
  if (restartEvents.length > 0) {
    FAIL(
      `bridge_restart fired ${restartEvents.length}× during normal startup`,
    );
  }
  console.log(`    PASSED — clean startup, no spurious wedge detection`);

  // ── Test that bindings cache populated correctly post-startup ─────────
  const bindings = bridge.getBindings();
  if (!bindings.indexRequest || bindings.indexRequest.repoPath !== process.cwd()) {
    FAIL(`bindings.indexRequest missing or wrong post-startup`);
  }
  if (!bindings.rlmConfig || bindings.rlmConfig.model !== 'openai/gpt-oss-20b') {
    FAIL(`bindings.rlmConfig missing or wrong post-startup`);
  }

  await bridge.shutdown();
  console.log('');
  console.log('PASS — startup bind sequence completes cleanly with no false-positive wedge.');
}

run().catch((err) => {
  console.error('UNHANDLED:', err);
  process.exit(1);
});
