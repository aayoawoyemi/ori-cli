/**
 * Unpaired UTF-16 surrogate sanitization for outbound API requests.
 *
 * Provider boundary defense against a recurring crash class: a fetched web
 * page, a tool_result containing partially-decoded text, or a model's own
 * output token-boundary cut can leave half a UTF-16 surrogate pair in a
 * string. JSON.stringify happily emits the lone code unit; Anthropic's
 * parser rejects with `invalid_request_error: invalid high surrogate in
 * string`. The next stream() call dies, the loop yields an error event, the
 * user sees "Aries stopped mid-response."
 *
 * Strategy: at each provider's stream() entry point, walk the messages
 * array and replace any unpaired surrogate code unit with U+FFFD
 * (REPLACEMENT CHARACTER). Idempotent on well-formed input. Ignorant of
 * higher-level structure — a surrogate inside an emoji that was correctly
 * paired stays untouched.
 *
 * Why provider boundary, not message-construction sites: dozens of places
 * build messages (tool_result, assistant text, history replay, compaction
 * output). Sanitizing at every site means dozens of regex calls to maintain.
 * One sanitize-on-send beats N sanitize-on-build with one wash pass per
 * outbound request.
 */
import type { Message, ContentBlock } from '../router/types.js';

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeSurrogates(s: string): string {
  return s.replace(UNPAIRED_SURROGATE, '�');
}

function sanitizeBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { ...block, text: sanitizeSurrogates(block.text) };
    case 'tool_result':
      return { ...block, content: sanitizeSurrogates(block.content) };
    case 'tool_use':
      // tool_use input is structured JSON. String fields inside the input
      // object can also carry corrupted content (e.g. an op's `code` field
      // that came back from a fetch and got round-tripped). Walk shallowly.
      return { ...block, input: sanitizeJsonValue(block.input) as Record<string, unknown> };
    case 'image':
      // Base64 image data is opaque. Nothing to sanitize.
      return block;
  }
}

function sanitizeJsonValue(v: unknown): unknown {
  if (typeof v === 'string') return sanitizeSurrogates(v);
  if (Array.isArray(v)) return v.map(sanitizeJsonValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = sanitizeJsonValue(val);
    }
    return out;
  }
  return v;
}

export function sanitizeMessages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { ...m, content: sanitizeSurrogates(m.content) };
    }
    return { ...m, content: m.content.map(sanitizeBlock) };
  });
}

export function sanitizeSystemPrompt(s: string): string {
  return sanitizeSurrogates(s);
}
