import type { Message, ContentBlock } from '../router/types.js';

/**
 * Rough token estimation. ~4 chars per token for English text.
 * Good enough for compaction threshold checks. Providers can give exact counts.
 */
const CHARS_PER_TOKEN = 4;

function contentLength(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return content.length;
  let len = 0;
  for (const block of content) {
    if (block.type === 'text') len += block.text.length;
    else if (block.type === 'tool_use') len += JSON.stringify(block.input).length + block.name.length;
    else if (block.type === 'tool_result') len += block.content.length;
  }
  return len;
}

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    total += contentLength(msg.content);
  }
  return Math.ceil(total / CHARS_PER_TOKEN);
}

export function estimateStringTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
