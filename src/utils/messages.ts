import type { Message, ContentBlock, ToolCall, TextContent, ToolUseContent } from '../router/types.js';

/** Get the text content from a message, ignoring tool blocks. */
export function getMessageText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b): b is TextContent => b.type === 'text')
    .map(b => b.text)
    .join('');
}

/** Find the last message with a given role. */
export function findLast(messages: Message[], role: Message['role']): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) return messages[i];
  }
  return undefined;
}

/** Extract tool calls from an assistant message's content blocks. */
export function extractToolCalls(msg: Message): ToolCall[] {
  if (typeof msg.content === 'string') return [];
  return msg.content
    .filter((b): b is ToolUseContent => b.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, input: b.input }));
}

/** Build an assistant message with text and tool calls. */
export function buildAssistantMessage(text: string, toolCalls: ToolCall[]): Message {
  const content: ContentBlock[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  return { role: 'assistant', content };
}

/** Build a tool result message. */
export function buildToolResultMessage(toolUseId: string, output: string, isError = false): Message {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: output,
      is_error: isError,
    }],
  };
}

/** Inject a system-reminder into the last user message (or create one). */
export function injectSystemReminder(messages: Message[], reminder: string): Message[] {
  const result = [...messages];
  // Find the last user message and append the reminder
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user' && typeof result[i].content === 'string') {
      result[i] = {
        ...result[i],
        content: `${result[i].content}\n\n<system-reminder>\n${reminder}\n</system-reminder>`,
      };
      return result;
    }
  }
  return result;
}
