import type { Message, ContentBlock } from '../router/types.js';
import { SessionStorage, type SessionEntry } from './storage.js';

/**
 * Reconstruct messages from a session JSONL file.
 * If a compact boundary exists, start from the last one.
 * Returns the messages array ready for the agent loop.
 *
 * Key challenge: the session log stores tool_call entries separately from
 * assistant text, but Anthropic's API expects assistant messages to contain
 * both text AND tool_use blocks in a single content array. We reconstruct
 * this by merging consecutive assistant + tool_call entries into one message.
 */
export function resumeFromSession(sessionPath: string): {
  messages: Message[];
  meta: SessionEntry | null;
} {
  const entries = SessionStorage.readSession(sessionPath);
  if (entries.length === 0) return { messages: [], meta: null };

  // Find the last compact boundary — start from there
  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compact_boundary') {
      startIdx = i;
      break;
    }
  }

  // Find meta entry
  const meta = entries.find(e => e.type === 'meta') ?? null;

  // Reconstruct messages from startIdx
  const messages: Message[] = [];
  const slice = entries.slice(startIdx);

  // We need to merge assistant text + tool_calls into one assistant message.
  // The log order is: assistant → tool_call → tool_call → tool_result → ...
  // So we buffer assistant content and flush when we see a non-tool_call entry.
  let assistantBuffer: ContentBlock[] | null = null;

  function flushAssistant(): void {
    if (assistantBuffer && assistantBuffer.length > 0) {
      // If it's just a single text block, keep content as string for compatibility
      if (assistantBuffer.length === 1 && assistantBuffer[0].type === 'text') {
        messages.push({ role: 'assistant', content: assistantBuffer[0].text });
      } else {
        messages.push({ role: 'assistant', content: assistantBuffer });
      }
    }
    assistantBuffer = null;
  }

  for (const entry of slice) {
    switch (entry.type) {
      case 'compact_boundary': {
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'compact_boundary' }>;
        messages.push({
          role: 'user',
          content: `<compaction-summary>\n${e.summary}\n</compaction-summary>\n\nContinue from where we left off.`,
          meta: { type: 'compact_boundary', compactedAt: e.timestamp },
        });
        break;
      }
      case 'user': {
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'user' }>;
        messages.push({ role: 'user', content: e.content });
        break;
      }
      case 'assistant': {
        // Start a new assistant buffer. If there's already one pending, flush it.
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'assistant' }>;
        // Skip empty text blocks — Anthropic API rejects messages with empty text content
        assistantBuffer = e.content ? [{ type: 'text', text: e.content }] : [];
        break;
      }
      case 'tool_call': {
        // Append tool_use block to the current assistant buffer.
        // If no assistant buffer exists (shouldn't happen but be defensive), create one.
        if (!assistantBuffer) {
          assistantBuffer = [];
        }
        const e = entry as Extract<SessionEntry, { type: 'tool_call' }>;
        assistantBuffer.push({
          type: 'tool_use',
          id: e.id,
          name: e.name,
          input: e.input,
        });
        break;
      }
      case 'tool_result': {
        // tool_result comes after tool_calls — flush the assistant message first
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'tool_result' }>;
        // Accumulate with any adjacent tool_results into one user message
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
          // Append to existing tool_result user message
          (lastMsg.content as ContentBlock[]).push({
            type: 'tool_result',
            tool_use_id: e.id,
            content: e.output,
            is_error: e.isError,
          });
        } else {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: e.id,
              content: e.output,
              is_error: e.isError,
            }],
          });
        }
        break;
      }
      // preflight/postflight/meta/error/interrupted are metadata — not conversation messages
    }
  }

  // Flush any trailing assistant buffer
  flushAssistant();

  return { messages, meta };
}
