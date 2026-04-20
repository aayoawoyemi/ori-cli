import type { Message, ContentBlock } from '../router/types.js';

/**
 * Rough token estimation. ~3.5 chars per token for mixed English + code.
 * Standardized 2026-04-19 to match estimateRequestTokens in the Anthropic
 * provider; previously this used 4.0 which underestimated by ~12% and caused
 * the 1M-beta trigger to misfire (request estimated at 178k but actual 198k).
 */
const CHARS_PER_TOKEN = 3.5;

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
