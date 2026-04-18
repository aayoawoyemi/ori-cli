import type { Message, ContentBlock, ToolCall, TextContent, ToolUseContent, ToolResultContent } from '../router/types.js';

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

/**
 * Reconcile orphaned tool_use blocks by injecting synthetic "interrupted"
 * tool_result entries. Anthropic's API rejects any assistant message whose
 * tool_use blocks don't have matching tool_result blocks in the immediately
 * following user message. This can happen when a tool execution is aborted,
 * throws, or the permission flow is abandoned mid-turn — leaving an orphaned
 * assistant turn in history that blocks all future requests.
 *
 * Mutates the array in place. Returns the number of orphans healed.
 */
export function healOrphanedToolUses(messages: Message[]): number {
  let healed = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

    const toolUseIds: string[] = [];
    for (const block of msg.content as ContentBlock[]) {
      if (block.type === 'tool_use') toolUseIds.push(block.id);
    }
    if (toolUseIds.length === 0) continue;

    const next = messages[i + 1];
    const existingResultIds = new Set<string>();
    const nextIsToolResultOnly =
      next &&
      next.role === 'user' &&
      Array.isArray(next.content) &&
      (next.content as ContentBlock[]).every(b => b.type === 'tool_result');

    if (nextIsToolResultOnly) {
      for (const block of next.content as ContentBlock[]) {
        if (block.type === 'tool_result') existingResultIds.add(block.tool_use_id);
      }
    }

    const missing = toolUseIds.filter(id => !existingResultIds.has(id));
    if (missing.length === 0) continue;

    const syntheticResults: ToolResultContent[] = missing.map(id => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'Tool execution interrupted — no result produced.',
      is_error: true,
    }));

    if (nextIsToolResultOnly) {
      // Safe to append — the next message is already a pure tool_result carrier.
      (next.content as ContentBlock[]).push(...syntheticResults);
    } else {
      // The next message is absent, text/image-bearing, or otherwise mixed.
      // Tool_result blocks cannot be mixed with text/image in the same user
      // message, so insert a dedicated tool_result message before it.
      messages.splice(i + 1, 0, { role: 'user', content: syntheticResults });
    }
    healed += missing.length;
  }
  return healed;
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
