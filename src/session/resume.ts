import type { ContentBlock, Message } from '../router/types.js';
import { SessionStorage, type SessionEntry } from './storage.js';

/**
 * Reconstruct provider-ready messages from a session JSONL file.
 *
 * Legacy sessions store native assistant/tool_call/tool_result events, which
 * are reconstructed as native tool protocol. Loop3 sessions store transcript
 * renderings for completed Repl calls, so resume keeps completed history as
 * text and never resurrects stale native tool_use/tool_result pairs.
 */
export function resumeFromSession(sessionPath: string): {
  messages: Message[];
  meta: SessionEntry | null;
} {
  const entries = SessionStorage.readSession(sessionPath);
  if (entries.length === 0) return { messages: [], meta: null };

  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'compact_boundary') {
      startIdx = i;
      break;
    }
  }

  const meta = entries.find(e => e.type === 'meta') ?? null;
  const messages: Message[] = [];
  const slice = entries.slice(startIdx);
  const hasLoop3Transcript = slice.some(e => e.type === 'loop3_transcript');

  let assistantBuffer: ContentBlock[] | null = null;
  let loop3AssistantText = '';
  let loop3PendingCode: { id: string; code: string } | null = null;

  function compactLoggedText(entry: {
    content_head?: string;
    content_tail?: string;
    code?: string;
    code_head?: string;
    code_tail?: string;
  }): string {
    if (typeof entry.code === 'string') return entry.code;
    const head = entry.content_head ?? entry.code_head ?? '';
    const tail = entry.content_tail ?? entry.code_tail ?? '';
    if (!tail || tail === head) return head;
    return `${head}\n\n[... truncated in session log ...]\n\n${tail}`;
  }

  function xmlAttr(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function cdataBlock(value: string): string {
    return `<![CDATA[\n${value.replace(/\]\]>/g, ']]]]><![CDATA[>')}\n]]>`;
  }

  function renderLoop3AssistantTranscript(text: string, id: string, code: string): string {
    return [
      text.trim(),
      [
        `<repl_call id="${xmlAttr(id)}">`,
        `<code>${cdataBlock(code.trimEnd())}</code>`,
        '</repl_call>',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }

  function renderLoop3ObservationTranscript(status: string, id: string, output: string): string {
    return [
      `<repl_observation id="${xmlAttr(id)}" status="${xmlAttr(status)}">`,
      `<output>${cdataBlock(output)}</output>`,
      '</repl_observation>',
    ].join('\n');
  }

  function migrateLoop3AssistantTranscript(text: string): string {
    return text.replace(
      /Executed Python \(([^)\r\n]+)\):\r?\n(`{3,})python\r?\n([\s\S]*?)\r?\n\2/g,
      (_match, id: string, _fence: string, code: string) => renderLoop3AssistantTranscript('', id, code),
    );
  }

  function migrateLoop3ObservationTranscript(text: string): string {
    return text.replace(
      /Observation \((ok|error), ([^)\r\n]+)\):\r?\n([\s\S]*?)(?=\r?\n\r?\nObservation \((?:ok|error), [^)\r\n]+\):\r?\n|$)/g,
      (_match, status: string, id: string, output: string) => renderLoop3ObservationTranscript(status, id, output.trim()),
    );
  }

  function flushAssistant(): void {
    if (assistantBuffer && assistantBuffer.length > 0) {
      if (assistantBuffer.length === 1 && assistantBuffer[0]!.type === 'text') {
        messages.push({ role: 'assistant', content: assistantBuffer[0]!.text });
      } else {
        messages.push({ role: 'assistant', content: assistantBuffer });
      }
    }
    assistantBuffer = null;
  }

  function flushLoop3NaturalText(): void {
    const text = loop3AssistantText.trim();
    if (text) {
      flushAssistant();
      messages.push({ role: 'assistant', content: text });
    }
    loop3AssistantText = '';
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
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'assistant' }>;
        assistantBuffer = e.content ? [{ type: 'text', text: e.content }] : [];
        break;
      }
      case 'tool_call': {
        if (!assistantBuffer) assistantBuffer = [];
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
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'tool_result' }>;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
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
      case 'loop3_transcript': {
        flushAssistant();
        const e = entry as Extract<SessionEntry, { type: 'loop3_transcript' }>;
        const assistant = migrateLoop3AssistantTranscript(e.assistant);
        const user = migrateLoop3ObservationTranscript(e.user);
        if (assistant.trim()) messages.push({ role: 'assistant', content: assistant });
        if (user.trim()) messages.push({ role: 'user', content: user });
        loop3AssistantText = '';
        loop3PendingCode = null;
        break;
      }
      case 'loop3_assistant_text': {
        const e = entry as Extract<SessionEntry, { type: 'loop3_assistant_text' }>;
        loop3AssistantText = compactLoggedText(e);
        break;
      }
      case 'loop3_tool_use': {
        if (hasLoop3Transcript) break;
        const e = entry as Extract<SessionEntry, { type: 'loop3_tool_use' }>;
        loop3PendingCode = {
          id: e.tool_call_id ?? e.cell_id ?? 'loop3-repl',
          code: compactLoggedText(e),
        };
        break;
      }
      case 'loop3_tool_result': {
        if (hasLoop3Transcript || !loop3PendingCode) break;
        const e = entry as Extract<SessionEntry, { type: 'loop3_tool_result' }>;
        flushAssistant();
        const assistantText = renderLoop3AssistantTranscript(
          loop3AssistantText,
          loop3PendingCode.id,
          loop3PendingCode.code,
        );
        const output = e.output?.trim()
          || `status=${e.status}, duration_ms=${e.duration_ms}, done_committed=${e.done_committed}`;
        messages.push({ role: 'assistant', content: assistantText });
        messages.push({ role: 'user', content: renderLoop3ObservationTranscript(e.status, loop3PendingCode.id, output) });
        loop3AssistantText = '';
        loop3PendingCode = null;
        break;
      }
      case 'loop3_turn_complete': {
        if (!loop3PendingCode) flushLoop3NaturalText();
        break;
      }
    }
  }

  flushAssistant();
  if (!loop3PendingCode) flushLoop3NaturalText();

  return { messages, meta };
}
