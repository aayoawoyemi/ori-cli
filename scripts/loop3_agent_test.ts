import assert from 'node:assert/strict';
import { agentLoop3 } from '../src/loop3/agent.js';
import type { ActionAdapter, ActionEvent, ActionRef, ExecutionResult } from '../src/loop3/types.js';
import type { Message, SystemPromptInput } from '../src/router/types.js';

class OneActionAdapter implements ActionAdapter {
  readonly providerName = 'test-adapter';

  async *stream(_messages: Message[], _systemPrompt: string): AsyncGenerator<ActionEvent> {
    yield {
      type: 'assistant_message',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Repl', input: { code: 'done("ok")' } }],
      },
    };
    yield { type: 'action', action: { kind: 'code', code: 'done("ok")' }, ref: { toolUseId: 'toolu_1' } };
    yield { type: 'done' };
  }

  buildResultMessage(_ref: ActionRef, result: ExecutionResult): Message {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: result.exception ?? 'ok' }] };
  }
}

let permissionAsked = false;
const events = [];
for await (const event of agentLoop3({
  messages: [{ role: 'user', content: 'test' }],
  systemPrompt: 'system',
  adapter: new OneActionAdapter(),
  replHandle: null,
  session: null,
  permissionMode: 'default',
  maxTurns: 1,
  onPermissionRequest: async (toolCall) => {
    permissionAsked = true;
    assert.equal(toolCall.name, 'Repl');
    assert.equal(toolCall.input.code, 'done("ok")');
    return 'deny';
  },
})) {
  events.push(event);
}

assert.equal(permissionAsked, true);
assert.deepEqual(events.map((event) => event.type), [
  'model_start',
  'action_start',
  'action_denied',
  'action_executed',
  'turn_complete',
  'error',
]);

console.log('loop3 permission ok');

class CutoffRecoveryAdapter implements ActionAdapter {
  readonly providerName = 'cutoff-test-adapter';
  calls = 0;

  async *stream(messages: Message[], _systemPrompt: SystemPromptInput): AsyncGenerator<ActionEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'text', content: 'partial answer' };
      yield { type: 'cutoff_warning', reason: 'max_tokens', message: 'stop_reason=max_tokens' };
      yield {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      };
      yield { type: 'done' };
      return;
    }

    const last = messages[messages.length - 1];
    assert.equal(last?.role, 'user');
    assert.match(typeof last.content === 'string' ? last.content : '', /Output token limit hit/);
    yield { type: 'text', content: 'recovered answer' };
    yield {
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'recovered answer' }] },
    };
    yield { type: 'done' };
  }

  buildResultMessage(_ref: ActionRef, _result: ExecutionResult): Message {
    return { role: 'user', content: 'unused' };
  }
}

const cutoffMessages: Message[] = [{ role: 'user', content: 'test cutoff' }];
const cutoffAdapter = new CutoffRecoveryAdapter();
const cutoffEvents = [];
for await (const event of agentLoop3({
  messages: cutoffMessages,
  systemPrompt: 'system',
  adapter: cutoffAdapter,
  replHandle: null,
  session: null,
  maxTurns: 2,
})) {
  cutoffEvents.push(event);
}

assert.equal(cutoffAdapter.calls, 2);
assert.deepEqual(cutoffEvents.map((event) => event.type), [
  'model_start',
  'text',
  'cutoff_warning',
  'max_output_recovery',
  'turn_complete',
  'model_start',
  'text',
  'turn_complete',
]);
const truncatedAssistant = cutoffMessages[1];
assert.equal(truncatedAssistant?.role, 'assistant');
assert.match(JSON.stringify(truncatedAssistant?.content), /\\[harness:cutoff reason=\\"max_tokens\\"\\]/);

console.log('loop3 cutoff recovery ok');
