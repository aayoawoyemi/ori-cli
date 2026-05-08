import assert from 'node:assert/strict';
import { agentLoop3, type Loop3Event } from '../src/loop3/agent.js';
import { ComposeController } from '../src/compose/controller.js';
import type { RequestMode } from '../src/compose/router.js';
import type { ActionAdapter, ActionEvent, ActionRef, ExecutionResult } from '../src/loop3/types.js';
import type { ReplHandle } from '../src/repl/setup.js';
import type { ReplResult } from '../src/repl/types.js';
import { renderSystemPrompt } from '../src/prompt.js';
import type { Message, SystemPromptInput } from '../src/router/types.js';

const DEAD_CATEGORY_RE = /\b(use|should|please|instead|need to|try)\b/i;

interface TurnScript {
  text: string;
  code?: string;
  toolUseId?: string;
}

class ScriptedAdapter implements ActionAdapter {
  readonly providerName = 'compose-loop-smoke';
  private turnIndex = 0;
  readonly systemPrompts: string[] = [];

  constructor(private readonly turns: TurnScript[]) {}

  async *stream(_messages: Message[], systemPrompt: SystemPromptInput): AsyncGenerator<ActionEvent> {
    this.systemPrompts.push(renderSystemPrompt(systemPrompt));
    const turn = this.turns[this.turnIndex++];
    if (!turn) {
      yield { type: 'done' };
      return;
    }

    if (turn.text) {
      yield { type: 'text', content: turn.text };
    }

    const blocks: Message['content'] = [];
    if (turn.text) blocks.push({ type: 'text', text: turn.text });
    if (turn.code !== undefined) {
      const toolUseId = turn.toolUseId ?? `toolu_${this.turnIndex}`;
      blocks.push({
        type: 'tool_use',
        id: toolUseId,
        name: 'Repl',
        input: { code: turn.code, id: `cell_${this.turnIndex}` },
      });
    }

    yield { type: 'assistant_message', message: { role: 'assistant', content: blocks } };

    if (turn.code !== undefined) {
      const toolUseId = turn.toolUseId ?? `toolu_${this.turnIndex}`;
      yield {
        type: 'action',
        action: { kind: 'code', code: turn.code, id: `cell_${this.turnIndex}` },
        ref: { toolUseId },
      };
    }

    yield { type: 'done' };
  }

  buildResultMessage(ref: ActionRef, result: ExecutionResult): Message {
    const toolUseId = (ref as { toolUseId?: string }).toolUseId ?? 'toolu_unknown';
    const parts: string[] = [];
    if (result.rejectedReason) parts.push(`rejected: ${result.rejectedReason}`);
    if (result.exception) parts.push(`exception: ${result.exception}`);
    for (const say of result.sayTexts) parts.push(`say: ${say}`);
    if (result.doneValue !== undefined) parts.push(`done: ${JSON.stringify(result.doneValue)}`);
    parts.push(`duration_ms: ${result.durationMs}`);
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: parts.join('\n'),
        is_error: result.rejectedReason !== null || result.exception !== null || result.timedOut,
      }],
    };
  }
}

class StubReplHandle implements Pick<ReplHandle, 'exec'> {
  readonly codes: string[] = [];

  async exec(execution: { code: string }): Promise<ReplResult> {
    this.codes.push(execution.code);
    const doneMatch = execution.code.match(/done\((["'])(.*?)\1\)/);
    // Test sentinel: cells containing RAISE_FOR_TEST simulate an exception
    // result so we can exercise the V2 repair-after-exception exemption
    // without standing up a real body subprocess.
    const shouldRaise = execution.code.includes('RAISE_FOR_TEST');
    return {
      stdout: '',
      stderr: '',
      exception: shouldRaise ? 'Traceback: synthetic test exception' : null,
      duration_ms: 1,
      rejected: null,
      timed_out: false,
      say_texts: shouldRaise ? [] : [`ran:${execution.code}`],
      ...(doneMatch ? { done: { value: doneMatch[2] } } : {}),
    };
  }
}

function preflight(fields: {
  purpose?: string;
  primitives?: string;
  cellKind?: string;
} = {}): string {
  return [
    '<compose_preflight>',
    `purpose: ${fields.purpose ?? 'inspect'}`,
    `primitives: ${fields.primitives ?? 'fs.read'}`,
    `cell_kind: ${fields.cellKind ?? 'composed'}`,
    '</compose_preflight>',
  ].join('\n');
}

function update(fields: { findings?: string; nextMove?: string } = {}): string {
  return [
    '<compose_update>',
    `findings: ${fields.findings ?? 'ok'}`,
    `next_move: ${fields.nextMove ?? 'continue'}`,
    '</compose_update>',
  ].join('\n');
}

async function runScenario(params: {
  mode: RequestMode;
  turns: TurnScript[];
  maxTurns?: number;
  scoutBudget?: number;
  bridge?: Partial<ReplHandle['bridge']>;
  systemPrompt?: SystemPromptInput | (() => SystemPromptInput | Promise<SystemPromptInput>);
}): Promise<{
  events: Loop3Event[];
  results: ExecutionResult[];
  rejections: string[];
  telemetry: ReturnType<ComposeController['telemetry']>;
  controllerEvents: Array<{ type: string; [k: string]: unknown }>;
  repl: StubReplHandle;
  adapter: ScriptedAdapter;
}> {
  const controllerEvents: Array<{ type: string; [k: string]: unknown }> = [];
  const controller = new ComposeController({
    mode: params.mode,
    requestId: `req_${params.mode}_smoke`,
    scoutBudget: params.scoutBudget,
    onEvent: event => controllerEvents.push(event),
  });
  const repl = new StubReplHandle();
  const adapter = new ScriptedAdapter(params.turns);
  const events: Loop3Event[] = [];

  for await (const event of agentLoop3({
    messages: [{ role: 'user', content: 'smoke' }],
    systemPrompt: params.systemPrompt ?? 'system',
    adapter,
    replHandle: {
      exec: repl.exec.bind(repl),
      bridge: (params.bridge ?? {}) as ReplHandle['bridge'],
      logger: {} as ReplHandle['logger'],
      shutdown: async () => {},
      isAlive: () => true,
    },
    session: null,
    permissionMode: 'accept',
    maxTurns: params.maxTurns ?? params.turns.length,
    composeController: controller,
  })) {
    events.push(event);
  }

  const results = events
    .filter((event): event is Extract<Loop3Event, { type: 'action_executed' }> => event.type === 'action_executed')
    .map(event => event.result);
  return {
    events,
    results,
    rejections: results.map(result => result.rejectedReason).filter((reason): reason is string => reason !== null),
    telemetry: controller.telemetry(),
    controllerEvents,
    repl,
    adapter,
  };
}

function assertNoDeadCategory(rejections: string[]): void {
  for (const rejection of rejections) {
    assert.equal(DEAD_CATEGORY_RE.test(rejection), false, `dead-category prose in rejection: ${rejection}`);
  }
}

const quick = await runScenario({
  mode: 'quick',
  turns: [{ text: 'plain quick call', code: 'done("quick-ok")' }],
});
assert.equal(quick.results.length, 1);
assert.equal(quick.results[0]!.rejectedReason, null);
assert.deepEqual(quick.repl.codes, ['done("quick-ok")']);
assert.equal(quick.telemetry.gate_rejections, 0);

// V2 (2026-05-08): all gate-firing tests now use NON-EXEMPT cells (fs.read,
// codebase.search) because commit/narration cells (say, done, ask) are
// exempted by the new pre-shape inspection. Prior test cells using say(...)
// were correct under V1 semantics but become exempt under V2; the test intent
// — "gate fires when discipline is violated" — is preserved by switching to
// real work primitives. The commit-only exemption gets its own dedicated case
// further down.
const missingPreflight = await runScenario({
  mode: 'compose',
  turns: [{ text: 'plain compose call', code: 'fs.read("package.json")' }],
});
assert.equal(missingPreflight.results.length, 1);
assert.match(missingPreflight.results[0]!.rejectedReason ?? '', /^ComposeGate: reason=preflight_required\b/);
assert.deepEqual(missingPreflight.repl.codes, []);

const allowedAfterPreflight = await runScenario({
  mode: 'compose',
  turns: [{ text: preflight({ purpose: 'read package metadata' }), code: 'fs.read("package.json")' }],
});
assert.equal(allowedAfterPreflight.results.length, 1);
assert.equal(allowedAfterPreflight.results[0]!.rejectedReason, null);
assert.deepEqual(allowedAfterPreflight.repl.codes, ['fs.read("package.json")']);
assert.equal(allowedAfterPreflight.telemetry.preflights_parsed, 1);

const secondWithoutUpdate = await runScenario({
  mode: 'compose',
  turns: [
    { text: preflight({ purpose: 'first call' }), code: 'data1 = fs.read("package.json")' },
    { text: 'next call, no update', code: 'data2 = fs.read("README.md")' },
  ],
});
assert.equal(secondWithoutUpdate.results.length, 2);
assert.equal(secondWithoutUpdate.results[0]!.rejectedReason, null);
assert.match(secondWithoutUpdate.results[1]!.rejectedReason ?? '', /^ComposeGate: reason=update_required\b/);
assert.deepEqual(secondWithoutUpdate.repl.codes, ['data1 = fs.read("package.json")']);

const secondAfterUpdate = await runScenario({
  mode: 'compose',
  turns: [
    { text: preflight({ purpose: 'first call' }), code: 'data1 = fs.read("package.json")' },
    { text: update({ findings: 'first call complete' }), code: 'data2 = fs.read("README.md")' },
  ],
});
assert.equal(secondAfterUpdate.results.length, 2);
assert.equal(secondAfterUpdate.results[0]!.rejectedReason, null);
assert.equal(secondAfterUpdate.results[1]!.rejectedReason, null);
assert.deepEqual(secondAfterUpdate.repl.codes, ['data1 = fs.read("package.json")', 'data2 = fs.read("README.md")']);
assert.equal(secondAfterUpdate.telemetry.preflights_parsed, 1);
assert.equal(secondAfterUpdate.telemetry.updates_parsed, 1);

const scoutBudget = await runScenario({
  mode: 'compose',
  scoutBudget: 2,
  turns: [
    { text: preflight({ purpose: 'scout one', cellKind: 'scout' }), code: 'd1 = fs.listdir(".")' },
    { text: `${update({ findings: 'scout one complete' })}\n${preflight({ purpose: 'scout two', cellKind: 'scout' })}`, code: 'd2 = fs.listdir("src")' },
    { text: `${update({ findings: 'scout two complete' })}\n${preflight({ purpose: 'scout three', cellKind: 'scout' })}`, code: 'd3 = fs.listdir("body")' },
  ],
});
assert.equal(scoutBudget.results.length, 3);
assert.equal(scoutBudget.results[0]!.rejectedReason, null);
assert.equal(scoutBudget.results[1]!.rejectedReason, null);
assert.match(scoutBudget.results[2]!.rejectedReason ?? '', /^ComposeGate: reason=scout_budget_exceeded\b/);
assert.deepEqual(scoutBudget.repl.codes, ['d1 = fs.listdir(".")', 'd2 = fs.listdir("src")']);
assert.equal(scoutBudget.telemetry.scout_count, 2);
assert.equal(scoutBudget.telemetry.gate_rejections, 1);

// ── V2 cases (2026-05-08): commit-cell exemption + repair-after-exception ──

// Case V2-A1: commit-only cell with NO preflight — exempt, allowed.
// Fixes the 07-pi-parallel-tool failure shape: model wants to fire a final
// done() cell after work is complete; gate should let it through without
// requiring a preflight or an update.
const exemptCommitNoPreflight = await runScenario({
  mode: 'compose',
  turns: [{ text: 'natural text answer', code: 'done("the answer")' }],
});
assert.equal(exemptCommitNoPreflight.results.length, 1);
assert.equal(exemptCommitNoPreflight.results[0]!.rejectedReason, null);
assert.deepEqual(exemptCommitNoPreflight.repl.codes, ['done("the answer")']);
assert.equal(exemptCommitNoPreflight.telemetry.gate_rejections, 0);

// Case V2-A2: final commit cell after a work cell with NO update emitted.
// This is the exact 07 failure pattern: model finishes a real cell, then
// wants to commit. Pre-V2 the gate rejected for update_required. Post-V2
// the commit cell is exempt and passes through.
const exemptCommitAfterWork = await runScenario({
  mode: 'compose',
  turns: [
    { text: preflight({ purpose: 'find the function' }), code: 'hits = codebase.search("foo")' },
    { text: 'I found it. Committing.', code: 'done({"function": "foo"})' },
  ],
});
assert.equal(exemptCommitAfterWork.results.length, 2);
assert.equal(exemptCommitAfterWork.results[0]!.rejectedReason, null);
assert.equal(exemptCommitAfterWork.results[1]!.rejectedReason, null);
assert.deepEqual(exemptCommitAfterWork.repl.codes, ['hits = codebase.search("foo")', 'done({"function": "foo"})']);
assert.equal(exemptCommitAfterWork.telemetry.gate_rejections, 0);

// Case V2-A3: commit cell with simple variable assignment + done. Exempt.
// Real-world pattern: the model assigns the answer to a var first then commits.
const exemptCommitWithAssignment = await runScenario({
  mode: 'compose',
  turns: [{ text: 'committing computed answer', code: 'answer = "the result"\ndone(answer)' }],
});
assert.equal(exemptCommitWithAssignment.results.length, 1);
assert.equal(exemptCommitWithAssignment.results[0]!.rejectedReason, null);

// Case V2-A3b: multi-line done({...}) is still commit-only. The interactive
// dogfood hit this exact shape: the old line-by-line exemption saw inner
// dict keys and rejected the commit for preflight_required.
const exemptMultilineDone = await runScenario({
  mode: 'compose',
  turns: [{
    text: 'committing multiline answer',
    code: `done({
  "plan_mode_used": False,
  "reused_prior_cell_results": True,
  "detail": "persistent namespace carried previous reads"
})`,
  }],
});
assert.equal(exemptMultilineDone.results.length, 1);
assert.equal(exemptMultilineDone.results[0]!.rejectedReason, null);

// Case V2-A3c: answer = {...}; done(answer) is also commit-only as long as
// the assignment is a literal payload, not a hidden work primitive call.
const exemptMultilineAnswerThenDone = await runScenario({
  mode: 'compose',
  turns: [{
    text: 'committing assigned multiline answer',
    code: `answer = {
  "plan_mode_used": False,
  "reused_prior_cell_results": True
}
done(answer)`,
  }],
});
assert.equal(exemptMultilineAnswerThenDone.results.length, 1);
assert.equal(exemptMultilineAnswerThenDone.results[0]!.rejectedReason, null);

const hiddenWorkInCommitStillGated = await runScenario({
  mode: 'compose',
  turns: [{
    text: 'fake commit with hidden work',
    code: `answer = {
  "body": fs.read("src/index.ts")
}
done(answer)`,
  }],
});
assert.match(hiddenWorkInCommitStillGated.results[0]!.rejectedReason ?? '', /^ComposeGate: reason=preflight_required\b/);

// Case V2-A4: NON-exempt cell still gets gated — the exemption isn't a
// universal bypass. A cell calling fs.read or codebase.search still requires
// the preflight discipline. This is the "the gate is still real" check.
const nonExemptStillGated = await runScenario({
  mode: 'compose',
  turns: [{ text: 'no preflight here', code: 'data = codebase.search("anything")' }],
});
assert.match(nonExemptStillGated.results[0]!.rejectedReason ?? '', /^ComposeGate: reason=preflight_required\b/);

// ── V2-B: repair-after-exception bypasses update_required ──
// Real flow: model emits work cell → cell exceptions → model emits a
// <compose_preflight> with cell_kind=repair → repair cell. Pre-V2 the
// gate rejected the repair for update_required because no <compose_update>
// was emitted between the exception and the repair. Post-V2 the repair
// preflight IS the implicit update; the gate exempts it.
const repairAfterException = await runScenario({
  mode: 'compose',
  turns: [
    {
      text: preflight({ purpose: 'first attempt' }),
      code: 'data = codebase.search("foo") # RAISE_FOR_TEST',
    },
    {
      // Note: NO <compose_update> between the exception and the repair.
      // Pre-V2 this triggers update_required rejection. V2 exempts it.
      text: preflight({ purpose: 'fix the search', cellKind: 'repair' }),
      code: 'data = codebase.search("foo_corrected")',
    },
  ],
});
assert.equal(repairAfterException.results.length, 2);
assert.equal(repairAfterException.results[0]!.exception, 'Traceback: synthetic test exception');
assert.equal(repairAfterException.results[1]!.rejectedReason, null,
  `repair-after-exception was rejected: ${repairAfterException.results[1]!.rejectedReason}`);
assert.deepEqual(repairAfterException.repl.codes, [
  'data = codebase.search("foo") # RAISE_FOR_TEST',
  'data = codebase.search("foo_corrected")',
]);
// Verify the exempt event was emitted (telemetry distinguishes "model
// behaved" from "gate let it through" from "gate caught a real lapse")
const repairExemptEvents = repairAfterException.controllerEvents.filter(
  e => e.type === 'compose_gate_exempt' && e.reason_code === 'exempt_repair_after_exception'
);
assert.equal(repairExemptEvents.length, 1, 'exempt_repair_after_exception event not emitted');

// V2-B negative case: a NON-repair preflight after exception still requires
// update. The exemption is specific to cell_kind=repair — it doesn't let
// the model claim "exception happened, no update needed" for arbitrary cells.
const nonRepairAfterExceptionStillGated = await runScenario({
  mode: 'compose',
  turns: [
    {
      text: preflight({ purpose: 'first attempt' }),
      code: 'data = codebase.search("foo") # RAISE_FOR_TEST',
    },
    {
      // cell_kind: composed (not repair) — gate should still fire on update_required
      text: preflight({ purpose: 'unrelated work' }),
      code: 'data = codebase.search("bar")',
    },
  ],
});
assert.match(nonRepairAfterExceptionStillGated.results[1]!.rejectedReason ?? '',
  /^ComposeGate: reason=update_required\b/);

const allRejections = [
  ...missingPreflight.rejections,
  ...secondWithoutUpdate.rejections,
  ...scoutBudget.rejections,
  ...nonExemptStillGated.rejections,
];
assertNoDeadCategory(allRejections);

const fakeScratch = {
  preflight: '',
  findings: [] as string[],
};
const dynamicPrompt = await runScenario({
  mode: 'compose',
  turns: [
    { text: preflight({ purpose: 'capture preflight into scratch' }), code: 'say("one")' },
    { text: `${update({ findings: 'first finding entered scratch' })}\n${preflight({ purpose: 'read scratch on next turn' })}`, code: 'say("two")' },
    { text: update({ findings: 'second finding entered scratch' }), code: undefined },
  ],
  bridge: {
    composeSet: async ({ section, text }: { section: string; text: string }) => {
      if (section === 'preflight') fakeScratch.preflight = text;
      return { ok: true };
    },
    composeAppend: async ({ section, text }: { section: string; text: string }) => {
      if (section === 'findings') fakeScratch.findings.push(text);
      return { ok: true };
    },
  },
  systemPrompt: () => ({
    stable: 'stable prompt',
    volatile: [
      '## Request Scratch',
      `preflight=${fakeScratch.preflight}`,
      `findings=${fakeScratch.findings.join('\n---\n')}`,
    ].join('\n'),
  }),
});
assert.equal(dynamicPrompt.adapter.systemPrompts.length, 3);
assert.doesNotMatch(dynamicPrompt.adapter.systemPrompts[0]!, /capture preflight into scratch/);
assert.match(dynamicPrompt.adapter.systemPrompts[1]!, /capture preflight into scratch/);
assert.doesNotMatch(dynamicPrompt.adapter.systemPrompts[1]!, /first finding entered scratch/);
assert.match(dynamicPrompt.adapter.systemPrompts[2]!, /first finding entered scratch/);
assert.match(dynamicPrompt.adapter.systemPrompts[2]!, /read scratch on next turn/);

console.log('compose loop smoke ok');
