import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicToolUseAdapter } from '../src/loop3/adapters/anthropic.js';
import { rewriteCompletedReplToolPairsInPlace } from '../src/loop3/agent.js';
import { resumeFromSession } from '../src/session/resume.js';
import type { Message, StreamEvent } from '../src/router/types.js';

class StubRouter {
  async *stream(_messages: Message[], _systemPrompt: string, tools: unknown[]): AsyncGenerator<StreamEvent> {
    assert.equal(Array.isArray(tools), true);
    assert.equal((tools as Array<{ name?: string }>)[0]?.name, 'Repl');
    yield { type: 'text', content: 'I will inspect the repo.' };
    yield { type: 'tool_use_start', id: 'toolu_1', name: 'Repl' };
    yield { type: 'tool_use_delta', id: 'toolu_1', delta: '{"code":"' };
    yield { type: 'tool_use_end', id: 'toolu_1', input: { code: 'say("ok")\ndone("package-name")', timeout_ms: 1234, id: 'read-package' } };
    yield { type: 'usage', inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    yield { type: 'done' };
  }
}

const adapter = new AnthropicToolUseAdapter(new StubRouter() as never);
const events = [];
for await (const event of adapter.stream([{ role: 'user', content: 'test' }], 'system')) {
  events.push(event);
}

assert.deepEqual(events.map((event) => event.type), ['text', 'usage', 'assistant_message', 'action', 'done']);

const assistant = events.find((event) => event.type === 'assistant_message');
assert.equal(assistant?.type, 'assistant_message');
assert.deepEqual(assistant.message, {
  role: 'assistant',
  content: [
    { type: 'text', text: 'I will inspect the repo.' },
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Repl',
      input: { code: 'say("ok")\ndone("package-name")', timeout_ms: 1234, id: 'read-package' },
    },
  ],
});

const action = events.find((event) => event.type === 'action');
assert.equal(action?.type, 'action');
assert.deepEqual(action.action, {
  kind: 'code',
  code: 'say("ok")\ndone("package-name")',
  timeoutMs: 1234,
  id: 'read-package',
});

const resultMessage = adapter.buildResultMessage(action.ref, {
  stdout: '',
  stderr: '',
  exception: null,
  rejectedReason: null,
  timedOut: false,
  durationMs: 7,
  sayTexts: ['ok'],
  doneValue: 'package-name',
});

assert.deepEqual(resultMessage, {
  role: 'user',
  content: [{
    type: 'tool_result',
    tool_use_id: 'toolu_1',
    content: 'say: ok\ndone: package-name\nduration_ms: 7',
    is_error: false,
  }],
});

const history: Message[] = [assistant.message, resultMessage];
assert.equal(rewriteCompletedReplToolPairsInPlace(history), 1);
assert.equal(history.length, 2);
assert.equal(history[0]?.role, 'assistant');
assert.equal(typeof history[0]?.content, 'string');
assert.doesNotMatch(history[0]?.content as string, /Executed Python \(toolu_1\):/);
assert.match(history[0]?.content as string, /<repl_call id="toolu_1">/);
assert.match(history[0]?.content as string, /<code><!\[CDATA\[\nsay\("ok"\)\ndone\("package-name"\)\n\]\]><\/code>/);
assert.equal(history[1]?.role, 'user');
assert.equal(typeof history[1]?.content, 'string');
assert.doesNotMatch(history[1]?.content as string, /Observation \(ok, toolu_1\):/);
assert.match(history[1]?.content as string, /<repl_observation id="toolu_1" status="ok">/);
assert.match(history[1]?.content as string, /done: package-name/);

const activeHistory: Message[] = [assistant.message];
assert.equal(rewriteCompletedReplToolPairsInPlace(activeHistory), 0);
assert.deepEqual(activeHistory[0], assistant.message);

const tmp = mkdtempSync(join(tmpdir(), 'loop3-resume-'));
try {
  const sessionPath = join(tmp, 'session.jsonl');
  writeFileSync(sessionPath, [
    JSON.stringify({
      type: 'loop3_transcript',
      assistant: 'prior text\n\nExecuted Python (toolu_old):\n```python\nsay("old")\n```',
      user: 'Observation (ok, toolu_old):\nold output',
      timestamp: Date.now(),
    }),
  ].join('\n'), 'utf-8');
  const resumed = resumeFromSession(sessionPath).messages;
  assert.equal(resumed.length, 2);
  assert.equal(resumed[0]?.role, 'assistant');
  assert.doesNotMatch(resumed[0]?.content as string, /Executed Python \(toolu_old\):/);
  assert.match(resumed[0]?.content as string, /<repl_call id="toolu_old">/);
  assert.equal(resumed[1]?.role, 'user');
  assert.doesNotMatch(resumed[1]?.content as string, /Observation \(ok, toolu_old\):/);
  assert.match(resumed[1]?.content as string, /<repl_observation id="toolu_old" status="ok">/);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const stateResultMessage = adapter.buildResultMessage(action.ref, {
  stdout: '',
  stderr: '',
  exception: null,
  rejectedReason: null,
  timedOut: false,
  durationMs: 9,
  sayTexts: [],
  runtime: {
    footer: 'state: candidates=list[2], ranked_docs=list[1]\nlast produced: ranked_docs=list[1]',
  },
});
assert.equal(Array.isArray(stateResultMessage.content), true);
assert.match((stateResultMessage.content as any[])[0].content, /state: candidates=list\[2\]/);

console.log('loop3 adapter ok');

class ThrowAfterToolEndRouter {
  async *stream(_messages: Message[], _systemPrompt: string, _tools: unknown[]): AsyncGenerator<StreamEvent> {
    yield { type: 'text', content: 'Recover this action.' };
    yield { type: 'tool_use_start', id: 'toolu_recover', name: 'Repl' };
    yield { type: 'tool_use_delta', id: 'toolu_recover', delta: '{"code":"done(123)"}' };
    yield { type: 'tool_use_end', id: 'toolu_recover', input: { code: 'done(123)' } };
    throw new Error('synthetic stream drop');
  }
}

const recoveryAdapter = new AnthropicToolUseAdapter(new ThrowAfterToolEndRouter() as never);
const recoveredEvents = [];
for await (const event of recoveryAdapter.stream([{ role: 'user', content: 'test' }], 'system')) {
  recoveredEvents.push(event);
}

assert.deepEqual(recoveredEvents.map((event) => event.type), ['text', 'assistant_message', 'action', 'error']);
const recoveredAction = recoveredEvents.find((event) => event.type === 'action');
assert.equal(recoveredAction?.type, 'action');
assert.deepEqual(recoveredAction.action, {
  kind: 'code',
  code: 'done(123)',
  timeoutMs: undefined,
  id: undefined,
});
const recoveredError = recoveredEvents.find((event) => event.type === 'error');
assert.equal(recoveredError?.type, 'error');
assert.equal(recoveredError.recoverable, true);

console.log('loop3 recovery ok');
