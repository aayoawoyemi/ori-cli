/**
 * Tier 0 diagnostic: verify the planned-phase composition wall actually fires
 * on a fresh body subprocess.
 *
 * Background: the recent dogfood showed a model running 21 micro Repl cells
 * inside an active plan phase without any wall rejection surfacing. Two
 * possible causes: (a) the body subprocess was stale relative to source
 * (wall code shipped but the running body predates it), or (b) the wall
 * predicate has a bug. This smoke disambiguates by spawning a FRESH body
 * subprocess, then exercising the exact pattern that should fire the wall.
 *
 * What it does:
 *   1. Spawn a fresh ReplBridge (forces a fresh body process).
 *   2. Verify the body reported a content_hash on first ping (if missing,
 *      body/version.py wiring is broken).
 *   3. Compare the body's running content_hash against on-disk hash. They
 *      MUST match — if they don't, this smoke is itself running stale.
 *   4. Configure with a state directory.
 *   5. Create a plan + enter a phase.
 *   6. Run a deliberate single-primitive cell (`fs.read("package.json")`).
 *      This is a micro cell with one non-exempt primitive while a phase is
 *      active. The wall should reject it with PlannedPhaseWall:.
 *   7. Verify rejection envelope shape: starts with "PlannedPhaseWall:",
 *      contains phase=, primitives=fs.read, exempted=, and contains NO
 *      corrective prose ("use", "should", "please", "instead").
 *   8. Run an exempt cell (`done({"check": "exempt"})`) — should NOT reject.
 *   9. Run a composed cell (multi-primitive) — should NOT reject.
 *
 * Exit codes:
 *   0 = wall works as designed
 *   1 = body version wiring broken (no content_hash in ping)
 *   2 = body source drift (this smoke is running stale)
 *   3 = wall did not fire on the expected case (predicate bug or wiring bug)
 *   4 = wall rejected an exempt case (false positive)
 *   5 = wall rejection contains corrective prose (dead category regression)
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ReplBridge, computeBodyContentHash } from '../src/repl/bridge.js';

function fail(code: number, message: string): never {
  console.error(`FAIL [${code}] ${message}`);
  process.exit(code);
}

function ok(message: string): void {
  console.log(`PASS  ${message}`);
}

async function main(): Promise<void> {
  const stateDir = join(process.cwd(), '.aries/tmp/wall-diagnostic-state');
  rmSync(stateDir, { recursive: true, force: true });

  const bridge = new ReplBridge({ timeoutMs: 30_000, onEvent: () => {} });
  await bridge.start();

  try {
    // ── Step 1: confirm the body is reporting version + content_hash ─
    // The heartbeat captures body info on the first pong (~1s after start);
    // awaitBodyInfo polls until populated. We use this rather than the
    // public ping() method because pings via request() get intercepted by
    // the onLine pong-routing branch and never resolve their pending entry.
    const info = await bridge.awaitBodyInfo(5_000);
    if (!info) fail(1, 'bodyInfo null after 5s wait; body never reported version fields (check body/version.py wiring)');
    if (!info.contentHash || info.contentHash.length !== 16) {
      fail(1, `bodyInfo.contentHash invalid: ${JSON.stringify(info)}`);
    }
    ok(`body version captured: ${info.version} sha=${info.sha} hash=${info.contentHash} started=${info.startedAt}`);

    // ── Step 2: confirm body source matches on-disk source ──────────
    const onDisk = computeBodyContentHash();
    if (onDisk !== info.contentHash) {
      fail(2, `body drift: running=${info.contentHash} onDisk=${onDisk}. ` +
        `Body subprocess is stale. Restart the smoke (it spawned a fresh body ` +
        `but body source changed before the spawn finished, OR there is a hash ` +
        `algorithm mismatch between body/version.py and bridge.ts).`);
    }
    ok(`body content_hash matches on-disk source: ${onDisk}`);

    // ── Step 3: configure + create plan + enter phase ───────────────
    await bridge.configure({ project: process.cwd(), stateDir });
    const setup = await bridge.exec({
      code: `
plan_result = plan.create(
  "wall diagnostic smoke",
  slug="wall-diagnostic",
  layers=[{
    "id": "1",
    "name": "DiagnosticPhase",
    "phases": [{
      "id": "1.1",
      "intent": "verify wall fires on micro non-exempt cells",
      "primitives": ["fs.read"],
      "produces_state": ["sentinel"],
      "composition": "single",
    }],
  }],
)
phase_in = plan.enter_phase("1.1")
done({"plan": plan_result, "phase": phase_in})
      `,
      timeout_ms: 30_000,
    });
    if (setup.rejected) fail(3, `setup rejected unexpectedly: ${setup.rejected.reason}`);
    if (setup.exception) fail(3, `setup exception: ${setup.exception}`);
    ok('plan created + phase entered');

    // ── Step 4: deliberate micro non-exempt cell — wall MUST fire ───
    const wallCase = await bridge.exec({
      code: `text = fs.read("package.json")`,
      timeout_ms: 10_000,
    });
    if (!wallCase.rejected) {
      fail(3, `wall did NOT fire on micro fs.read inside active phase. ` +
        `Result: ${JSON.stringify(wallCase, null, 2)}`);
    }
    const reason = wallCase.rejected.reason ?? '';
    if (!reason.startsWith('PlannedPhaseWall:')) {
      fail(3, `rejection reason missing PlannedPhaseWall prefix: ${reason}`);
    }
    if (!reason.includes('phase=1.1')) {
      fail(3, `rejection reason missing phase=1.1: ${reason}`);
    }
    if (!reason.includes('primitives=fs.read')) {
      fail(3, `rejection reason missing primitives=fs.read: ${reason}`);
    }
    if (!reason.includes('exempted=')) {
      fail(3, `rejection reason missing exempted= section: ${reason}`);
    }
    // Dead category guard: corrective prose patterns. If any of these slip
    // back in, the wall has regressed to advisory-text mode (vault canon).
    if (/\b(use|should|please|instead|need to|try)\b/i.test(reason)) {
      fail(5, `WALL REGRESSION: rejection contains corrective prose: ${reason}`);
    }
    ok(`wall fired with structural data: ${reason}`);

    // ── Step 5: exempt cell — wall must NOT fire ────────────────────
    const exemptCase = await bridge.exec({
      code: `done({"exempt": True})`,
      timeout_ms: 10_000,
    });
    if (exemptCase.rejected) {
      fail(4, `wall fired on exempt done() call: ${exemptCase.rejected.reason}`);
    }
    ok('exempt done() cell was not rejected');

    // ── Step 6: composed cell — wall must NOT fire ──────────────────
    const composedCase = await bridge.exec({
      code: `
hits = codebase.search("planning")
state.put("sentinel", len(hits))
text = fs.read("package.json")
done({"hits": len(hits), "text_len": len(text)})
      `,
      timeout_ms: 10_000,
    });
    if (composedCase.rejected) {
      fail(4, `wall fired on composed cell (3+ primitives): ${composedCase.rejected.reason}`);
    }
    ok('composed multi-primitive cell was not rejected');

    console.log('\nPASS body wall diagnostic smoke');
  } finally {
    await bridge.shutdown().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`UNCAUGHT: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(99);
});
