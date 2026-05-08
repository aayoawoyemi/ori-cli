/**
 * Tier 2 smoke: compose sub-loop scratch substrate end-to-end.
 *
 * Verifies:
 *   1. Bridge configure with session_id + request_id wires up the body's
 *      ENV_SESSION_ID / ENV_REQUEST_ID for path computation.
 *   2. scratch_start (composeStart) creates the markdown file with the
 *      template + pre-filled User request section.
 *   3. Body footer surfaces "scratch: active filled=N/M intent='...'" line.
 *   4. scratch.append (model-side) adds a timestamped entry to a section.
 *   5. scratch.set replaces a section's contents.
 *   6. scratch.read returns the full file contents.
 *   7. scratch.status reflects sections_filled / sections_empty correctly.
 *   8. scratch_close (composeClose) deletes the file.
 *   9. sweepOrphanScratches removes stale files.
 */
import { rmSync, existsSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ReplBridge } from '../src/repl/bridge.js';
import { sweepOrphanScratches } from '../src/compose/scratch.js';

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}
function ok(message: string): void {
  console.log(`PASS  ${message}`);
}

async function main(): Promise<void> {
  const stateDir = join(process.cwd(), '.aries/tmp/scratch-smoke-state');
  const requestsDir = join(process.cwd(), '.aries/tmp/requests');
  rmSync(stateDir, { recursive: true, force: true });
  // Don't blast the whole requests dir — other concurrent dev sessions might
  // have live scratches there. We'll only clean up what we create.
  const sessionId = 'smoke_session';
  const requestId = 'req_smoke01';
  const expectedPath = join(requestsDir, `${sessionId}-${requestId}.md`);
  rmSync(expectedPath, { force: true });

  const bridge = new ReplBridge({ timeoutMs: 30_000, onEvent: () => {} });
  await bridge.start();

  try {
    // ── Step 1: configure with session + request ids ────────────────
    await bridge.configure({
      project: process.cwd(),
      stateDir,
      sessionId,
      requestId,
      composeMode: 'compose',
    });
    ok('configure with session_id + request_id');

    // ── Step 2: scratch_start creates the file ──────────────────────
    const startResp = await bridge.composeStart({
      intent: 'verify scratch substrate end-to-end',
      userRequest: 'Run the scratch substrate smoke and confirm every primitive works.',
      mode: 'compose',
    });
    if (!startResp.ok) fail(`composeStart failed: ${JSON.stringify(startResp)}`);
    if (!existsSync(expectedPath)) fail(`scratch file not created at ${expectedPath}`);
    ok(`composeStart created scratch at ${expectedPath}`);

    // ── Step 3: footer surfaces scratch indicator ───────────────────
    const r1 = await bridge.exec({ code: 'print(scratch.status())', timeout_ms: 5_000 });
    const footer1 = r1.runtime?.footer ?? '';
    if (!footer1.includes('scratch: active')) {
      fail(`footer missing scratch indicator: ${footer1}`);
    }
    if (!footer1.includes("intent='verify scratch substrate end-to-end")) {
      // Intent may be truncated to 32 chars + ellipsis — accept either form.
      if (!/intent='verify scratch substrate end-?…?/.test(footer1)) {
        fail(`footer missing intent: ${footer1}`);
      }
    }
    ok('footer surfaces scratch active + intent');

    // ── Step 4: scratch.append adds timestamped entry to findings ───
    const r2 = await bridge.exec({
      code: `r = scratch.append("findings", "scout returned 3 candidates"); print(r)`,
      timeout_ms: 5_000,
    });
    if (r2.exception) fail(`append exception: ${r2.exception}`);
    if (!r2.stdout.includes("'ok': True")) fail(`append did not return ok: ${r2.stdout}`);
    ok('scratch.append wrote to findings');

    // ── Step 5: scratch.set replaces section contents ───────────────
    const r3 = await bridge.exec({
      code: `r = scratch.set("preflight", "Purpose: read 3 files. Primitives: fs.read."); print(r)`,
      timeout_ms: 5_000,
    });
    if (r3.exception) fail(`set exception: ${r3.exception}`);
    if (!r3.stdout.includes("'ok': True")) fail(`set did not return ok: ${r3.stdout}`);
    ok('scratch.set replaced preflight');

    // ── Step 6: scratch.read returns full contents ──────────────────
    const r4 = await bridge.exec({
      code: `text = scratch.read(); print(len(text)); print("FINDINGS_PRESENT" if "scout returned 3 candidates" in text else "missing"); print("PREFLIGHT_PRESENT" if "Purpose: read 3 files" in text else "missing"); print("USER_REQUEST_PRESENT" if "Run the scratch substrate smoke" in text else "missing"); print("FINAL_AUDIT_PRESENT" if "Completion audit before final done(value)" in text else "missing")`,
      timeout_ms: 5_000,
    });
    if (r4.exception) fail(`read exception: ${r4.exception}`);
    if (!r4.stdout.includes('FINDINGS_PRESENT')) fail(`findings not in scratch read: ${r4.stdout}`);
    if (!r4.stdout.includes('PREFLIGHT_PRESENT')) fail(`preflight not in scratch read: ${r4.stdout}`);
    if (!r4.stdout.includes('USER_REQUEST_PRESENT')) fail(`user_request not in scratch read: ${r4.stdout}`);
    if (!r4.stdout.includes('FINAL_AUDIT_PRESENT')) fail(`final audit not in scratch read: ${r4.stdout}`);
    ok('scratch.read shows findings, preflight, user_request');

    // ── Step 7: scratch.status reflects sections_filled correctly ───
    const r5 = await bridge.exec({
      code: `s = scratch.status(); print("filled:", sorted(s.get("sections_filled", []))); print("active:", s.get("active"))`,
      timeout_ms: 5_000,
    });
    if (r5.exception) fail(`status exception: ${r5.exception}`);
    if (!r5.stdout.includes('active: True')) fail(`status not active: ${r5.stdout}`);
    if (!r5.stdout.includes("'findings'")) fail(`status missing findings filled: ${r5.stdout}`);
    if (!r5.stdout.includes("'preflight'")) fail(`status missing preflight filled: ${r5.stdout}`);
    ok('scratch.status reports findings + preflight as filled');

    // ── Step 8: scratch.append rejects unknown sections (no silent acc) ─
    const r6 = await bridge.exec({
      code: `r = scratch.append("garbage_section", "should fail"); print(r)`,
      timeout_ms: 5_000,
    });
    if (!r6.stdout.includes("'error'") && !r6.stdout.includes('error')) {
      fail(`append to unknown section should fail: ${r6.stdout}`);
    }
    ok('scratch.append rejects unknown section');

    // ── Step 9: composeClose removes the file ───────────────────────
    const closeResp = await bridge.composeClose();
    if (!closeResp.ok) fail(`composeClose failed: ${JSON.stringify(closeResp)}`);
    if (!closeResp.existed) fail(`composeClose reported file did not exist (it should have): ${JSON.stringify(closeResp)}`);
    if (existsSync(expectedPath)) fail(`scratch file still present after close: ${expectedPath}`);
    ok('composeClose deleted scratch file');

    // ── Step 10: footer hides scratch line when none active ─────────
    const r7 = await bridge.exec({ code: 'print("post-close")', timeout_ms: 5_000 });
    const footer2 = r7.runtime?.footer ?? '';
    if (footer2.includes('scratch: active')) {
      fail(`footer still shows scratch active after close: ${footer2}`);
    }
    ok('footer hides scratch line when not active');

    // ── Step 11: orphan sweeper removes old files ───────────────────
    mkdirSync(requestsDir, { recursive: true });
    const oldFile = join(requestsDir, `${sessionId}-orphan_test.md`);
    writeFileSync(oldFile, '# stale\n');
    // Backdate mtime by 30 hours
    const past = (Date.now() - 30 * 3600 * 1000) / 1000;
    utimesSync(oldFile, past, past);
    const swept = sweepOrphanScratches(process.cwd(), 24);
    if (swept < 1) fail(`sweeper did not delete the stale file: deleted=${swept}`);
    if (existsSync(oldFile)) fail(`stale file still present: ${oldFile}`);
    ok(`sweeper removed ${swept} stale file${swept === 1 ? '' : 's'}`);

    console.log('\nPASS scratch substrate smoke');
  } finally {
    await bridge.shutdown().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(expectedPath, { force: true });
  }
}

main().catch((err) => {
  console.error(`UNCAUGHT: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(99);
});
