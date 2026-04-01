import type { Message } from '../router/types.js';
import { SessionStorage, type SessionEntry } from './storage.js';

/**
 * Reconstruct messages from a session JSONL file.
 * If a compact boundary exists, start from the last one.
 * Returns the messages array ready for the agent loop.
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

  for (const entry of slice) {
    switch (entry.type) {
      case 'compact_boundary': {
        const e = entry as Extract<SessionEntry, { type: 'compact_boundary' }>;
        messages.push({
          role: 'user',
          content: `<compaction-summary>\n${e.summary}\n</compaction-summary>\n\nContinue from where we left off.`,
          meta: { type: 'compact_boundary', compactedAt: e.timestamp },
        });
        break;
      }
      case 'user': {
        const e = entry as Extract<SessionEntry, { type: 'user' }>;
        messages.push({ role: 'user', content: e.content });
        break;
      }
      case 'assistant': {
        const e = entry as Extract<SessionEntry, { type: 'assistant' }>;
        messages.push({ role: 'assistant', content: e.content });
        break;
      }
      case 'tool_result': {
        const e = entry as Extract<SessionEntry, { type: 'tool_result' }>;
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: e.id,
            content: e.output,
            is_error: e.isError,
          }],
        });
        break;
      }
      // tool_call entries are part of assistant messages (already captured),
      // preflight/postflight/meta/error are metadata — not conversation messages
    }
  }

  return { messages, meta };
}
