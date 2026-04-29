/**
 * Host-pause detection test (Phase 2 of 2026-04-29 fixes).
 *
 * Verifies that ReplBridge.tickHeartbeat correctly distinguishes:
 *   - Event-loop pause (laptop sleep, modern standby, debugger break,
 *     long sync JS stall) — NO restart
 *   - Real body wedge — restart fires after verify-before-restart latch
 *
 * Note: an earlier version of this test (and the corresponding bridge
 * code) used dual-clock skew (Date.now vs performance.now) to detect
 * suspend, but Windows QueryPerformanceCounter doesn't reliably freeze
 * during sleep — confirmed by live telemetry showing skew ≈ 0 on a real
 * 36-minute suspend. Revised to use wall-clock delta alone, threshold
 * 10× heartbeat interval (10 seconds). Simpler and OS-agnostic.
 *
 * Approach: bypass the real subprocess entirely. Construct a ReplBridge,
 * stub out the process so isAlive() returns true and write() is a no-op,
 * directly mutate private heartbeat fields, then invoke tickHeartbeat()
 * via cast. Read the resulting diagnostic event types from
 * ~/.aries/diagnostics/recovery.jsonl to assert expected behavior.
 *
 * Why no subprocess: the bug we're testing is purely in the heartbeat tick
 * logic — what it does in response to specific (sinceLastPong, wallDelta,
 * perfDelta) inputs. A real subprocess adds noise (real I/O, real timing,
 * non-determinism) without testing anything new.
 *
 * Run with:   npx tsx bench/recovery/suspend-test.ts
 */
import { ReplBridge } from '../../src/repl/bridge.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

// Cast helper: poke private fields on the bridge so we can simulate exactly
// the (lastPongAt, lastTickWallMs, lastTickPerfMs, verificationPending)
// state that triggers each branch. Production code never touches these
// directly; the test does because the alternative is reaching into setInterval
// and racing real timers, which we don't need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BridgePrivate = any;

const RECOVERY_LOG = join(homedir(), '.aries', 'diagnostics', 'recovery.jsonl');

interface DiagnosticRecord {
  ts: string;
  event: string;
  [key: string]: unknown;
}

function readDiagnosticsSince(byteOffset: number): DiagnosticRecord[] {
  try {
    const buf = readFileSync(RECOVERY_LOG, 'utf-8');
    const fresh = buf.slice(byteOffset);
    return fresh.split('\n').filter(l => l.trim()).map(l => {
      try { return JSON.parse(l) as DiagnosticRecord; } catch { return null; }
    }).filter((r): r is DiagnosticRecord => r !== null);
  } catch {
    return [];
  }
}

function currentLogSize(): number {
  try { return statSync(RECOVERY_LOG).size; } catch { return 0; }
}

let passed = 0;
let failed = 0;
function expect(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/**
 * Build a bridge with its process slot stubbed so isAlive() is true and
 * stdin writes are no-ops. The heartbeat tick branches we test only touch
 * `this.process?.isAlive()` and `this.process.write(...)` — both are
 * routed through the stub.
 */
function makeStubbedBridge(): { bridge: ReplBridge; events: { type: string; [k: string]: unknown }[] } {
  const events: { type: string; [k: string]: unknown }[] = [];
  const bridge = new ReplBridge({
    onEvent: (e) => events.push(e as { type: string; [k: string]: unknown }),
  });
  // Stub the private process slot. The fields the heartbeat tick reads are
  // isAlive() and write(...). Restart triggers shutdown() / new process —
  // we don't test the restart path here, just the trip detection.
  let pingsSent = 0;
  (bridge as BridgePrivate).process = {
    isAlive: () => true,
    write: (_line: string) => { pingsSent++; return true; },
    shutdown: async () => undefined,
    start: async () => undefined,
  };
  // Initialize heartbeat baselines as startHeartbeat would, but without
  // arming the real setInterval (we don't want stray timers).
  (bridge as BridgePrivate).heartbeatSuspended = false;
  (bridge as BridgePrivate).lastPongAt = Date.now();
  (bridge as BridgePrivate).lastTickWallMs = 0;
  (bridge as BridgePrivate).lastTickPerfMs = 0;
  (bridge as BridgePrivate).verificationPending = false;
  // Mark as not-restarting so the tick path doesn't early-return.
  (bridge as BridgePrivate).restarting = false;
  return { bridge, events };
}

/**
 * Drive one tick with explicit (wall, perf) state. Sets up the previous-tick
 * baselines, then mutates Date.now / performance.now globally for the
 * duration of the tick call so the bridge sees the simulated clocks.
 */
function tickWith(
  bridge: ReplBridge,
  prev: { wall: number; perf: number },
  current: { wall: number; perf: number },
  lastPongAt: number,
): void {
  (bridge as BridgePrivate).lastTickWallMs = prev.wall;
  (bridge as BridgePrivate).lastTickPerfMs = prev.perf;
  (bridge as BridgePrivate).lastPongAt = lastPongAt;

  const realDate = Date.now;
  const realPerf = performance.now;
  Date.now = () => current.wall;
  performance.now = () => current.perf;
  try {
    (bridge as BridgePrivate).tickHeartbeat();
  } finally {
    Date.now = realDate;
    performance.now = realPerf;
  }
}

async function main(): Promise<void> {
  console.log('[suspend-test] starting');

  // ── Case 1: pure host suspend ──────────────────────────────────────
  // Wall clock advanced 30 minutes; monotonic clock advanced 1 second.
  // Skew = 1,799,000ms >> 5_000ms threshold. Expected:
  //   - heartbeat_host_pause_detected diagnostic written
  //   - NO bridge_unhealthy event
  //   - NO restart triggered (verificationPending stays false)
  {
    console.log('\n[suspend-test] Case 1: pure host suspend (30 min wall, 1 s perf)');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    const baseWall = 1_000_000;
    const basePerf = 100;
    tickWith(
      bridge,
      { wall: baseWall, perf: basePerf },
      { wall: baseWall + 1_800_000, perf: basePerf + 1_000 },
      baseWall,  // lastPongAt = pre-suspend
    );
    const after = readDiagnosticsSince(before);
    expect('host_pause_detected diagnostic written',
      after.some(r => r.event === 'heartbeat_host_pause_detected'),
      `events: ${after.map(r => r.event).join(', ')}`);
    expect('NO bridge_unhealthy event emitted',
      !events.some(e => e.type === 'bridge_unhealthy'));
    expect('NO heartbeat_unhealthy diagnostic',
      !after.some(r => r.event === 'heartbeat_unhealthy'));
    expect('lastPongAt rebased to current wall time',
      (bridge as BridgePrivate).lastPongAt === baseWall + 1_800_000);
    expect('verificationPending cleared',
      (bridge as BridgePrivate).verificationPending === false);
  }

  // ── Case 2: real body wedge ────────────────────────────────────────
  // Both clocks advanced 5 seconds (no suspend). Body has been silent
  // since lastPongAt (which is 5s in the past). First tick should set
  // verificationPending and fire a fresh ping; second tick (still no
  // pong) declares unhealthy.
  {
    console.log('\n[suspend-test] Case 2: real body wedge (5s on both clocks, no pong)');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    const baseWall = 2_000_000;
    const basePerf = 200;
    // First tick: trip staleness, set verificationPending.
    tickWith(
      bridge,
      { wall: baseWall, perf: basePerf },
      { wall: baseWall + 5_000, perf: basePerf + 5_000 },
      baseWall,  // lastPongAt 5s in the past
    );
    expect('first staleness tick sets verification latch',
      (bridge as BridgePrivate).verificationPending === true);
    expect('first staleness tick does NOT emit unhealthy',
      !events.some(e => e.type === 'bridge_unhealthy'));
    const afterFirst = readDiagnosticsSince(before);
    expect('first staleness tick writes heartbeat_staleness_verify',
      afterFirst.some(r => r.event === 'heartbeat_staleness_verify'));

    // Second tick: still stale (lastPongAt unchanged, simulated body never
    // responded). verificationPending is true → fire unhealthy.
    const before2 = currentLogSize();
    tickWith(
      bridge,
      { wall: baseWall + 5_000, perf: basePerf + 5_000 },
      { wall: baseWall + 6_000, perf: basePerf + 6_000 },
      baseWall,  // still no pong
    );
    expect('second staleness tick emits bridge_unhealthy',
      events.some(e => e.type === 'bridge_unhealthy'));
    const afterSecond = readDiagnosticsSince(before2);
    expect('second staleness tick writes heartbeat_unhealthy',
      afterSecond.some(r => r.event === 'heartbeat_unhealthy'));
  }

  // ── Case 3: modern standby / throttled tick ────────────────────────
  // Wall advanced 12 seconds. Even when perf advanced TOO (proving QPC
  // doesn't freeze on this hardware), wall delta alone exceeds the
  // 10s threshold. Expected: treated as host pause, no unhealthy.
  {
    console.log('\n[suspend-test] Case 3: 12s wall gap (perf followed)');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    const baseWall = 3_000_000;
    const basePerf = 300;
    tickWith(
      bridge,
      { wall: baseWall, perf: basePerf },
      { wall: baseWall + 12_000, perf: basePerf + 12_000 },  // perf followed wall
      baseWall,
    );
    const after = readDiagnosticsSince(before);
    expect('12s wall gap treated as host pause regardless of perf delta',
      after.some(r => r.event === 'heartbeat_host_pause_detected'));
    expect('12s wall gap does NOT emit bridge_unhealthy',
      !events.some(e => e.type === 'bridge_unhealthy'));
  }

  // ── Case 4: small wall gap, real wedge ─────────────────────────────
  // Wall advanced 5s, well under the 10s pause threshold. Body has been
  // silent for 5s. Treated as real wedge: first tick sets verify latch.
  {
    console.log('\n[suspend-test] Case 4: 5s wall gap, real wedge (under pause threshold)');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    const baseWall = 4_000_000;
    const basePerf = 400;
    tickWith(
      bridge,
      { wall: baseWall, perf: basePerf },
      { wall: baseWall + 5_000, perf: basePerf + 5_000 },
      baseWall,
    );
    expect('5s wall gap with stale pong sets verify latch',
      (bridge as BridgePrivate).verificationPending === true);
    expect('5s wall gap does NOT trigger host_pause_detected',
      !readDiagnosticsSince(before).some(r => r.event === 'heartbeat_host_pause_detected'));
  }

  // ── Case 4b: long suspend where BOTH clocks advanced together ──────
  // The exact scenario from telemetry that broke the dual-clock fix:
  // wall advanced 36 minutes, perf advanced 36 minutes (Windows QPC
  // ran through suspend). Expected: still detected as host pause via
  // wall-delta-only check.
  {
    console.log('\n[suspend-test] Case 4b: 36min suspend with QPC-running-through-sleep');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    const baseWall = 4_500_000;
    const basePerf = 450;
    tickWith(
      bridge,
      { wall: baseWall, perf: basePerf },
      // BOTH advanced 36 minutes — perf did NOT freeze, mimicking real
      // Windows QPC behavior on modern hardware.
      { wall: baseWall + 2_160_000, perf: basePerf + 2_160_000 },
      baseWall,
    );
    expect('36min suspend with running perf clock STILL detected as pause',
      readDiagnosticsSince(before).some(r => r.event === 'heartbeat_host_pause_detected'));
    expect('36min suspend does NOT emit bridge_unhealthy',
      !events.some(e => e.type === 'bridge_unhealthy'));
  }

  // ── Case 5: first-tick edge case (lastTickWallMs = 0) ──────────────
  // On the first tick after startHeartbeat, lastTickWallMs is 0 (sentinel
  // that says "no prior baseline, skip skew check"). Even if the apparent
  // skew computed from 0 baselines would look enormous, we should NOT
  // treat it as a host pause — there's no valid prior tick to measure
  // against. Expected: skew check skipped, normal staleness check runs.
  {
    console.log('\n[suspend-test] Case 5: first tick after start (no prior baseline)');
    const before = currentLogSize();
    const { bridge, events } = makeStubbedBridge();
    // lastTickWallMs is already 0 from makeStubbedBridge — leave it.
    (bridge as BridgePrivate).lastTickWallMs = 0;
    (bridge as BridgePrivate).lastTickPerfMs = 0;
    (bridge as BridgePrivate).lastPongAt = 5_000_000 - 100; // 100ms ago, healthy
    const realDate = Date.now;
    const realPerf = performance.now;
    Date.now = () => 5_000_000;
    performance.now = () => 500;
    try {
      (bridge as BridgePrivate).tickHeartbeat();
    } finally {
      Date.now = realDate;
      performance.now = realPerf;
    }
    const after = readDiagnosticsSince(before);
    expect('first tick does NOT trigger host_pause_detected',
      !after.some(r => r.event === 'heartbeat_host_pause_detected'));
    expect('first tick does NOT trigger bridge_unhealthy (body is healthy)',
      !events.some(e => e.type === 'bridge_unhealthy'));
    expect('first tick records baseline for next tick',
      (bridge as BridgePrivate).lastTickWallMs === 5_000_000);
  }

  console.log(`\n[suspend-test] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
