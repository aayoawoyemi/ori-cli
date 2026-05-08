import type { Message, SystemPromptInput } from '../../router/types.js';
import type { ActionAdapter, ActionEvent, ActionRef, ExecutionResult } from '../types.js';

export class OpenAIToolUseAdapter implements ActionAdapter {
  readonly providerName = 'openai-tool-use';

  async *stream(_messages: Message[], _systemPrompt: SystemPromptInput, _signal?: AbortSignal): AsyncGenerator<ActionEvent> {
    yield { type: 'error', error: new Error('OpenAIToolUseAdapter is not implemented yet.') };
  }

  buildResultMessage(_ref: ActionRef, _result: ExecutionResult): Message {
    throw new Error('OpenAIToolUseAdapter is not implemented yet.');
  }
}
