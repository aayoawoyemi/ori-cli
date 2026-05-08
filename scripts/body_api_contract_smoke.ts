import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ReplBridge } from '../src/repl/bridge.js';

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is not an object: ${JSON.stringify(value)}`);
  }
}

async function main(): Promise<void> {
  const bridge = new ReplBridge({
    timeoutMs: 30_000,
    onEvent: () => {},
  });
  const path = '.aries/tmp/body-api-contract-smoke.txt';
  const stateDir = join(process.cwd(), '.aries/tmp/body-api-contract-state');
  let planPath: string | null = null;

  rmSync(stateDir, { recursive: true, force: true });
  await bridge.start();
  try {
    await bridge.configure({ project: process.cwd(), stateDir });
    const code = `
content = "alpha\\nbeta\\nem dash: \\u2014\\n"
write_result = fs.write(${JSON.stringify(path)}, content)
roundtrip = fs.read(${JSON.stringify(path)})
edit_result = fs.edit(${JSON.stringify(path)}, "beta", "BETA")
edited = fs.read(${JSON.stringify(path)})
shell_result = shell.run("node --version")
state.put("candidates", [{"path": "package.json"}, {"path": "src/index.ts"}], note="smoke input")
candidates_roundtrip = state.get("candidates")
plan_result = plan.create(
  "body api smoke goal",
  intent="verify plan/spanner/state primitives",
  slug="body-api-smoke",
  layers=[{
    "id": "1",
    "name": "Smoke",
    "phases": [{
      "id": "1.1",
      "intent": "exercise plan phase telemetry",
      "primitives": ["fs.read", "shell.run", "state.put", "state.get"],
      "consumes_state": ["candidates"],
      "produces_state": ["ranked_docs"],
      "composition": "pipeline",
    }],
  }],
)
phase_start = plan.enter_phase("1.1")
spanner_status = spanner.escalate("smoke needs one planned verification layer", layers=1)
missing_exit = plan.exit_phase("1.1", outputs={"should_fail": True})
state.put("ranked_docs", candidates_roundtrip[:1], note="smoke output")
phase_end = plan.exit_phase("1.1", outputs={"roundtrip": roundtrip == content, "edited": "BETA" in edited})
done({
  "write_result": write_result,
  "roundtrip_matches": roundtrip == content,
  "edit_result": edit_result,
  "edited_contains": "BETA" in edited,
  "shell_result": shell_result,
  "state_has_candidates": state.has("candidates"),
  "state_receipts": state.receipts(),
  "candidates_roundtrip": candidates_roundtrip,
  "plan_result": plan_result,
  "phase_start": phase_start,
  "missing_exit": missing_exit,
  "phase_end": phase_end,
  "spanner_status": spanner_status,
})
`;

    const result = await bridge.exec({ code, timeout_ms: 30_000 });
    if (result.rejected) fail(`rejected: ${result.rejected.reason}`);
    if (result.exception) fail(`exception: ${result.exception}`);
    if (result.timed_out) fail('timed out');

    assertRecord(result.done?.value, 'done value');
    const value = result.done.value;
    if (value.roundtrip_matches !== true) fail(`fs.write -> fs.read mismatch: ${JSON.stringify(value)}`);
    if (value.edited_contains !== true) fail(`fs.edit did not update content: ${JSON.stringify(value)}`);
    assertRecord(value.write_result, 'write_result');
    assertRecord(value.edit_result, 'edit_result');
    assertRecord(value.shell_result, 'shell_result');
    assertRecord(value.plan_result, 'plan_result');
    assertRecord(value.phase_start, 'phase_start');
    assertRecord(value.missing_exit, 'missing_exit');
    assertRecord(value.phase_end, 'phase_end');
    assertRecord(value.spanner_status, 'spanner_status');
    planPath = typeof value.plan_result.path === 'string' ? value.plan_result.path : null;

    const shellResult = value.shell_result;
    if (typeof shellResult.stdout !== 'string' || !/^v\d+\./.test(shellResult.stdout.trim())) {
      fail(`shell.run stdout shape/content mismatch: ${JSON.stringify(shellResult)}`);
    }
    if (!('code' in shellResult) || !('stderr' in shellResult)) {
      fail(`shell.run missing stable keys: ${JSON.stringify(shellResult)}`);
    }
    if (value.plan_result.ok !== true || typeof value.plan_result.path !== 'string') {
      fail(`plan.create shape/content mismatch: ${JSON.stringify(value.plan_result)}`);
    }
    if (value.state_has_candidates !== true || !Array.isArray(value.state_receipts) || value.state_receipts.length < 2) {
      fail(`state.put/get/receipts mismatch: ${JSON.stringify(value)}`);
    }
    if (!Array.isArray(value.candidates_roundtrip) || value.candidates_roundtrip.length !== 2) {
      fail(`state.get roundtrip mismatch: ${JSON.stringify(value.candidates_roundtrip)}`);
    }
    if (typeof value.missing_exit.error !== 'string' || !Array.isArray(value.missing_exit.missing_produces_state)) {
      fail(`plan.exit_phase did not reject missing produced state: ${JSON.stringify(value.missing_exit)}`);
    }
    if (value.phase_start.ok !== true || value.phase_end.ok !== true) {
      fail(`plan phase enter/exit mismatch: ${JSON.stringify({ start: value.phase_start, end: value.phase_end })}`);
    }
    if (value.spanner_status.tier !== 'planned' || value.spanner_status.layers !== 1) {
      fail(`spanner.escalate mismatch: ${JSON.stringify(value.spanner_status)}`);
    }
    if (!result.runtime?.footer?.includes('spanner: planned')) {
      fail(`runtime footer missing spanner state: ${JSON.stringify(result.runtime)}`);
    }
    if (!result.runtime?.footer?.includes('state: candidates=list[2], ranked_docs=list[1]')) {
      fail(`runtime footer missing state receipts: ${JSON.stringify(result.runtime)}`);
    }
    if (!Array.isArray(result.runtime?.telemetry) || result.runtime.telemetry.length === 0) {
      fail(`runtime telemetry missing: ${JSON.stringify(result.runtime)}`);
    }

    const wallSetup = await bridge.exec({
      code: `
wall_plan = plan.create(
  "composition wall smoke",
  slug="composition-wall-smoke",
  layers=[{
    "id": "1",
    "name": "Wall",
    "phases": [{
      "id": "1.1",
      "intent": "force composed phase reads",
      "primitives": ["fs.read", "state.put"],
      "produces_state": ["wall_result"],
      "composition": "pipeline",
    }],
  }],
)
plan.enter_phase("1.1")
done(wall_plan)
`,
      timeout_ms: 30_000,
    });
    if (wallSetup.rejected) fail(`composition wall setup rejected: ${wallSetup.rejected.reason}`);
    if (wallSetup.exception) fail(`composition wall setup exception: ${wallSetup.exception}`);
    assertRecord(wallSetup.done?.value, 'composition wall setup');
    planPath = typeof wallSetup.done.value.path === 'string' ? wallSetup.done.value.path : planPath;

    const wallResult = await bridge.exec({
      code: `text = fs.read(${JSON.stringify(path)})`,
      timeout_ms: 30_000,
    });
    const wallReason = wallResult.rejected?.reason ?? '';
    if (
      !wallReason.startsWith('PlannedPhaseWall:') ||
      !wallReason.includes('phase=1.1') ||
      !wallReason.includes('primitives=fs.read') ||
      !wallReason.includes('exempted=')
    ) {
      fail(`active phase micro read was not rejected with structured wall code: ${JSON.stringify(wallResult)}`);
    }
    if (/use state\.put|use plan\.|should|please/i.test(wallReason)) {
      fail(`wall reason contains corrective prose (dead category): ${wallReason}`);
    }

    console.log('PASS body API bridge contract smoke');
  } finally {
    await bridge.shutdown().catch(() => {});
    rmSync(join(process.cwd(), path), { force: true });
    rmSync(stateDir, { recursive: true, force: true });
    if (planPath) rmSync(planPath, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
