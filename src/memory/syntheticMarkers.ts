/**
 * Stable markers for synthetic content injected into user messages.
 *
 * Every turn, preflight + current_state + proprioception get wrapped in markers
 * so they can be stripped idempotently before new injection. Without markers,
 * each turn's injection stacks on top of previous turns, linearly accumulating
 * stale memory context (the Finding 4 bug).
 *
 * Markers use HTML comment syntax — invisible in most markdown renders, won't
 * collide with user text, greppable.
 */
import type { Message } from '../router/types.js';

/** Wrap synthetic content with open/close markers. */
export function wrapSynthetic(kind: string, content: string): string {
  if (!content.trim()) return '';
  return `<!--ORI_SYNTH-START:${kind}-->\n${content}\n<!--ORI_SYNTH-END:${kind}-->`;
}

/**
 * Strip synthetic blocks from text. If `kind` is provided, strips only that
 * kind. Otherwise strips ALL synthetic blocks.
 */
export function stripSynthetic(text: string, kind?: string): string {
  if (typeof text !== 'string') return text;
  const kindPattern = kind ? escapeRegex(kind) : '[a-z_-]+';
  // Match block + surrounding whitespace (newlines before/after)
  const re = new RegExp(
    `\\s*<!--ORI_SYNTH-START:${kindPattern}-->[\\s\\S]*?<!--ORI_SYNTH-END:${kindPattern}-->\\s*`,
    'g',
  );
  return text.replace(re, match => {
    // Preserve at most one newline to avoid collapsing paragraphs
    const leadingNewline = /^\s*\n/.test(match) ? '\n' : '';
    const trailingNewline = /\n\s*$/.test(match) ? '\n' : '';
    return leadingNewline && trailingNewline ? '\n\n' : leadingNewline || trailingNewline;
  }).trim();
}

/**
 * Strip all synthetic blocks from every user message's content (in place).
 * Idempotent: safe to call multiple times. O(N) over messages.
 */
export function stripSyntheticFromMessages(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    const cleaned = stripSynthetic(m.content);
    if (cleaned !== m.content) {
      messages[i] = { ...m, content: cleaned };
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inject all turn-level synthetic blocks into the latest user message.
 *
 * Order (top to bottom in user.content):
 *   1. preflightBefore  (historical memory context)
 *   2. [user's actual message]
 *   4. preflightAfter   (contradictions as required-response blocks)
 *   5. proprio          (context-status block, highest salience before generation)
 *
 * All blocks are wrapped with stable markers so the next turn can strip them
 * idempotently via stripSyntheticFromMessages().
 *
 * Precondition: stripSyntheticFromMessages() should have run first this turn.
 */
export interface TurnSynthetics {
  preflightBefore?: string;
  preflightAfter?: string;
  proprio?: string;
}

export function injectTurnSynthetics(
  messages: Message[],
  blocks: TurnSynthetics,
): void {
  // Find latest user message with string content
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return;

  const userContent = messages[lastUserIdx].content as string;

  // Build leading block (before user text)
  const beforeParts: string[] = [];
  if (blocks.preflightBefore) {
    beforeParts.push(wrapSynthetic('preflight-before', `<system-reminder>\n<memory-context>\n${blocks.preflightBefore}\n</memory-context>\n</system-reminder>`));
  }
  const leading = beforeParts.length > 0 ? beforeParts.join('\n\n') + '\n\n' : '';

  // Build trailing block (after user text)
  const afterParts: string[] = [];
  if (blocks.preflightAfter) {
    afterParts.push(wrapSynthetic('preflight-after', blocks.preflightAfter));
  }
  if (blocks.proprio) {
    afterParts.push(wrapSynthetic('proprio', `<system-reminder>\n${blocks.proprio}\n</system-reminder>`));
  }
  const trailing = afterParts.length > 0 ? '\n\n' + afterParts.join('\n\n') : '';

  if (!leading && !trailing) return;

  messages[lastUserIdx] = {
    ...messages[lastUserIdx],
    content: `${leading}${userContent}${trailing}`,
  };
}
