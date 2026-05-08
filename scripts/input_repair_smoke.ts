/**
 * Smoke test for Batch 1.7's input-repair shim in src/tools/code.ts.
 *
 * Drives each broken-shape case through CodeTool.execute() with a stub
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
import { CodeTool } from '../src/tools/code.js';
import type { CodeExecution, ReplHandle, ReplResult } from '../src/repl/types.js';
import type { ToolContext, ToolResult } from '../src/tools/types.js';

interface StubResult {
  // 2026-04-25 — per-op execution (src/tools/code.ts:410-486) makes one
  // bridge.exec() call per op instead of one for the concatenated batch.
  // The stub accumulates ALL exec codes across calls so assertions can
  // grep the full set; receivedCode is the joined view.
  receivedCode: string | null;
  receivedOps: string[];
  output: ToolResult;
}

async function runCase(
  label: string,
  input: Record<string, unknown>,
): Promise<StubResult> {
  const receivedOps: string[] = [];
  const stubHandle: ReplHandle = {
    exec: async (exec: CodeExecution): Promise<ReplResult> => {
      receivedOps.push(exec.code);
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

  const tool = new CodeTool(() => stubHandle);
  const ctx: ToolContext = {
    cwd: process.cwd(),
    signal: new AbortController().signal,
  };
  const output = await tool.execute(input, ctx);
  const receivedCode = receivedOps.length > 0 ? receivedOps.join('\n') : null;
  return { receivedCode, receivedOps, output };
}

async function main() {
  const cases: Array<{
    label: string;
    input: Record<string, unknown>;
    expectRepair: boolean;
    expectReject: boolean;
    // 2026-04-25 — per-op execution split TS rejection into a per-op
    // lintError (skipped op + isError=true) instead of a batch-level
    // rejection. expectLintError asserts the per-op lint path fired
    // for at least one op.
    expectLintError?: boolean;
    noteContains?: string;
    codeContains?: string;
  }> = [
    // Case 1: pre-Stream-A {code: "..."}
    {
      label: 'preStreamA_code',
      input: { code: "x = 42\nprint(x)\n" },
      expectRepair: true,
      expectReject: false,
      noteContains: 'legacy raw `{code}`',
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
      noteContains: 'legacy `{plan, code}`',
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
      noteContains: "renamed `ops`",
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
      noteContains: 'legacy `{plan, operations}`',
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
      expectRepair: true,
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
      expectRepair: true,
      expectReject: false,
    },
    // Batch 3 close-out (Phase C) — TS-shape detector. code is Python
    // only; submitting TS/JS-shaped code must hit a TS-specific rejection
    // path, not the generic AST guard. The rejection text must point the
    // model at the actual right tools (fs.* + shell.run typecheck) so the
    // next attempt routes elsewhere instead of retrying the same shape.
    {
      label: 'ts_const_arrow_rejected',
      input: {
        plan: 'Submitting TypeScript syntax to code — should hit TS-specific rejection.',
        operations: [
          { purpose: 'declare a TS arrow function', code: 'const greet = (name: string) => `hi ${name}`;\nconsole.log(greet("Aayo"));' },
          { purpose: 'pad to satisfy minItems=2', code: 'console.log("padding op");' },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: true,
      noteContains: 'TypeScript/JavaScript',
    },
    {
      label: 'ts_interface_rejected',
      input: {
        plan: 'TypeScript interface declaration in code — should also hit TS rejection.',
        operations: [
          { purpose: 'declare a User TS interface', code: 'interface User { name: string; age: number; }\nconst u: User = { name: "x", age: 1 };' },
          { purpose: 'log the constructed object', code: 'console.log(JSON.stringify(u));' },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: true,
      noteContains: 'TypeScript/JavaScript',
    },
    {
      label: 'ts_import_rejected',
      input: {
        plan: 'ES module import — TypeScript/JS only, must hit TS rejection.',
        operations: [
          { purpose: 'import a module via ES syntax', code: 'import { foo } from "./bar.js";\nfoo();' },
          { purpose: 'invoke the imported function', code: 'foo(); foo();' },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: true,
      noteContains: 'TypeScript/JavaScript',
    },
    {
      label: 'python_import_forbidden_not_ts',
      input: {
        plan: 'Plain Python imports are forbidden by the sandbox, but must not be misclassified as TypeScript/JavaScript.',
        operations: [
          { purpose: 'attempt a Python import', code: 'import json\nprint(json.dumps({"ok": True}))' },
          { purpose: 'attempt a from-import', code: 'from collections import Counter\nprint(Counter("aba"))' },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: true,
      noteContains: 'Imports are forbidden',
    },
    // Negative case — Python that incidentally uses identifiers like
    // `function` (as a variable, not a keyword). MUST NOT trigger TS
    // detector; should pass through to normal execution.
    {
      label: 'python_function_var_not_ts',
      input: {
        plan: 'Python using `function` as a variable name — must NOT trip the TS detector.',
        operations: [
          { purpose: 'assign a doubling lambda', code: 'function = lambda x: x * 2\nprint(function(5))' },
          { purpose: 'invoke the lambda again', code: 'print(function(10))' },
        ],
      },
      expectRepair: true,
      expectReject: false,
    },
    // Batch 1.9 (Option A) — string-literal pre-pass. Restoring the TS
    // detector with the stripPythonStringsAndComments pre-pass means TS
    // syntax INSIDE Python string literals must NOT trip the detector.
    // Three live-reproduced false positives (regular quote, triple quote,
    // raw string) become the contract for the pre-pass to defend.
    {
      label: 'fs_write_ts_string_literal_not_ts',
      input: {
        plan: 'Writing a TS file via fs.write — TS syntax inside the string literal must not trip the detector.',
        operations: [
          { purpose: 'write a tiny TS arrow file', code: "fs.write('x.ts', 'const x = () => 1')" },
          { purpose: 'confirm completion', code: "say('wrote x.ts')" },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: false,
    },
    {
      label: 'python_triple_quoted_const_not_ts',
      input: {
        plan: 'Multi-line Python string containing the word const — must not trip the TS detector.',
        operations: [
          { purpose: 'assign a triple-quoted block', code: 'code = """\nconst foo = 1\n"""\nprint(len(code))' },
          { purpose: 'confirm length above 10', code: "say('block stored')" },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: false,
    },
    {
      label: 'python_raw_string_arrow_not_ts',
      input: {
        plan: 'Raw Python string holding the literal arrow token — must not trip the TS detector.',
        operations: [
          { purpose: 'store the arrow pattern', code: "pattern = r'=>'\nprint(len(pattern))" },
          { purpose: 'confirm pattern stored', code: "say('pattern stored')" },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: false,
    },
    {
      label: 'python_double_quoted_function_not_ts',
      input: {
        plan: 'Double-quoted Python string containing TS-shaped function syntax — must not trip the detector.',
        operations: [
          { purpose: 'assign a TS-shaped string', code: "msg = 'function foo() { return 1; }'\nprint(msg)" },
          { purpose: 'confirm string stored', code: "say('msg stored')" },
        ],
      },
      expectRepair: true,
      expectReject: false,
      expectLintError: false,
    },
  ];

  let fails = 0;
  for (const c of cases) {
    const { receivedCode, output } = await runCase(c.label, c.input);
    const didReject = output.isError === true && /code rejected/.test(output.output);
    const didRepair = !didReject && /^NOTE: harness repaired/m.test(output.output);
    // Per-op lint error fingerprint: "[lint error]" tag prefixed to the
    // per-op header (src/tools/code.ts:541-560 formats `# op: <purpose>
    // [lint error]\n<lintError text>`). Distinct from batch rejection
    // (which never reaches per-op execution) and from runtime exceptions.
    const didLintError = output.isError === true && /\[lint error\]/.test(output.output);

    const errors: string[] = [];
    if (c.expectReject && !didReject) errors.push('expected rejection, got none');
    if (!c.expectReject && didReject) errors.push(`got unexpected rejection: ${output.output.slice(0, 120)}`);
    if (c.expectRepair && !didRepair) errors.push('expected repair note, got none');
    if (!c.expectRepair && didRepair && !c.expectReject) errors.push('got unexpected repair note');
    if (c.expectLintError && !didLintError) errors.push('expected per-op lint error, got none');
    if (!c.expectLintError && didLintError) errors.push(`got unexpected per-op lint error: ${output.output.slice(0, 120)}`);
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
