import type { Message, SystemPromptInput } from '../../router/types.js';
import type { ActionAdapter, ActionEvent, ActionRef, ExecutionResult } from '../types.js';

export class JsonActionAdapter implements ActionAdapter {
  readonly providerName = 'json-action';

  async *stream(_messages: Message[], _systemPrompt: SystemPromptInput, _signal?: AbortSignal): AsyncGenerator<ActionEvent> {
    yield { type: 'error', error: new Error('JsonActionAdapter is not implemented yet.') };
  }

  buildResultMessage(_ref: ActionRef, _result: ExecutionResult): Message {
    throw new Error('JsonActionAdapter is not implemented yet.');
  }
}
