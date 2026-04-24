/**
 * Smoke test for Batch 1.7's input-repair shim in src/tools/repl.ts.
 *
 * Drives each broken-shape case through ReplTool.execute() with a stub
 * handle that records what code actually ran and what tool_result the
 * harness generated. Asserts per case that:
 *   1. The exec dispatched WITH a valid concatenated code string.
 *   2. The tool_result output begins with a `NOTE: harness repaired ...`
 *      line so the model sees what happened.
 *   3. Un-repairable broken shapes still hit the rejection path.
 *
 * Run: npm run build && node dist-test-like-run... — or just compile
 * with tsx for this one file.
 */
import { ReplTool } from '../src/tools/repl.js';
import type { CodeExecution, ReplHandle, ReplResult } from '../src/repl/types.js';
import type { ToolContext, ToolResult } from '../src/tools/types.js';

interface StubResult {
  receivedCode: string | null;
  output: ToolResult;
}

async function runCase(
  label: string,
  input: Record<string, unknown>,
): Promise<StubResult> {
  let receivedCode: string | null = null;
  const stubHandle: ReplHandle = {
    exec: async (exec: CodeExecution): Promise<ReplResult> => {
      receivedCode = exec.code;
      return {
        stdout: `[${label}] ran`,
        stderr: '',
        exception: null,
        duration_ms: 5,
        rejected: null,
        timed_out: false,
      } as ReplResult;
    },
    shutdown: async () => {},
    isReady: () => true,
    restart: async () => {},
  };

  const tool = new ReplTool(() => stubHandle);
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
  };
  const output = await tool.execute(input, ctx);
  return { receivedCode, output };
}

async function main() {
  const cases: Array<{
    label: string;
    input: Record<string, unknown>;
    expectRepair: boolean;
    expectReject: boolean;
    noteContains?: string;
    codeContains?: string;
  }> = [
    // Case 1: pre-Stream-A {code: "..."}
    {
      label: 'preStreamA_code',
      input: { code: "x = 42\nprint(x)\n" },
      expectRepair: true,
      expectReject: false,
      noteContains: 'pre-Stream-A',
      codeContains: 'x = 42',
    },
    // Case 2: {plan, code} — code at root
    {
      label: 'plan_plus_code',
      input: {
        plan: 'Run the computed diff and confirm the output — repaired from plan+code shape.',
        code: "d = 2 + 2\nprint(d)\n",
      },
      expectRepair: true,
      expectReject: false,
      noteContains: 'code` at root into operations[0]',
      codeContains: 'd = 2 + 2',
    },
    // Case 3: {plan, operations: "[...json...]"} — stringified operations
    {
      label: 'stringified_ops',
      input: {
        plan: 'Compute two values and print the sum — testing the stringified-operations repair path.',
        operations: JSON.stringify([
          { purpose: 'compute first', code: 'a = 1 + 1\nprint(a)' },
          { purpose: 'compute second', code: 'b = 2 + 2\nprint(b)' },
        ]),
      },
      expectRepair: true,
      expectReject: false,
      noteContains: 'JSON-parsed',
      codeContains: 'a = 1 + 1',
    },
    // Case 4: {plan, ops: [...]} — wrong key name
    {
      label: 'wrong_key_ops',
      input: {
        plan: 'Two small computations — testing the ops-rename repair path end-to-end.',
        ops: [
          { purpose: 'compute alpha', code: 'alpha = 10\nprint(alpha)' },
          { purpose: 'compute beta', code: 'beta = 20\nprint(beta)' },
        ],
      },
      expectRepair: true,
      expectReject: false,
      noteContains: "renamed `ops` to `operations`",
      codeContains: 'alpha = 10',
    },
    // Case 5: missing purpose — synthesize from leading comment
    {
      label: 'missing_purpose_comment',
      input: {
        plan: 'Two ops both missing the purpose field — should synthesize from leading comments.',
        operations: [
          { code: "# load config\nconfig = {'k': 1}\nprint(config)" },
          { code: "# validate config\nassert 'k' in config\nprint('ok')" },
        ],
      },
      expectRepair: true,
      expectReject: false,
      noteContains: 'synthesized missing `purpose`',
      codeContains: 'config =',
    },
    // Already valid — no repair, no note, no rejection
    {
      label: 'already_valid',
      input: {
        plan: 'Plain valid input — should not trigger any repair path and should execute cleanly.',
        operations: [
          { purpose: 'step one', code: 'print("one")' },
          { purpose: 'step two', code: 'print("two")' },
        ],
      },
      expectRepair: false,
      expectReject: false,
      codeContains: 'print("one")',
    },
    // Un-repairable — genuinely broken, rejection path must fire
    {
      label: 'unrepairable',
      input: { garbage: 'nope' },
      expectRepair: false,
      expectReject: true,
    },
    // 1-op submission — DELIBERATELY NOT repaired (schema floor)
    {
      label: 'one_op_not_repaired',
      input: {
        plan: 'A single-op submission that must hit the rejection path — schema floor is load-bearing.',
        operations: [{ purpose: 'lone op', code: 'print("alone")' }],
      },
      expectRepair: false,
      expectReject: true,
    },
  ];

  let fails = 0;
  for (const c of cases) {
    const { receivedCode, output } = await runCase(c.label, c.input);
    const didReject = output.isError === true && /Repl rejected/.test(output.output);
    const didRepair = !didReject && /^NOTE: harness repaired/m.test(output.output);

    const errors: string[] = [];
    if (c.expectReject && !didReject) errors.push('expected rejection, got none');
    if (!c.expectReject && didReject) errors.push(`got unexpected rejection: ${output.output.slice(0, 120)}`);
    if (c.expectRepair && !didRepair) errors.push('expected repair note, got none');
    if (!c.expectRepair && didRepair && !c.expectReject) errors.push('got unexpected repair note');
    if (c.noteContains && !output.output.includes(c.noteContains)) {
      errors.push(`note missing text: "${c.noteContains}"`);
    }
    if (c.codeContains && !(receivedCode ?? '').includes(c.codeContains)) {
      errors.push(`dispatched code missing: "${c.codeContains}"`);
    }

    if (errors.length === 0) {
      console.log(`  OK   ${c.label}`);
    } else {
      fails += 1;
      console.log(`  FAIL ${c.label}`);
      for (const e of errors) console.log(`       ${e}`);
      console.log(`       output (first 200): ${output.output.slice(0, 200)}`);
      console.log(`       receivedCode (first 120): ${(receivedCode ?? '<none>').slice(0, 120)}`);
    }
  }

  console.log(`\n${cases.length - fails}/${cases.length} repair-smoke cases passed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
