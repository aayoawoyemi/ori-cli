/**
 * Stable markers for synthetic content injected into user messages.
 *
 * Per-turn blocks (proprioception, etc.) get wrapped in markers so they can
 * be stripped idempotently before new injection. Without markers, each turn's
 * injection stacks on top of previous turns, linearly accumulating stale
 * context (the Finding 4 bug).
 *
 * Markers use HTML comment syntax — invisible in most markdown renders, won't
 * collide with user text, greppable.
 *
 * Preflight blocks (preflightBefore/After) removed 2026-04-21 — preflight
 * itself was killed 2026-04-19; this wrapper's preflight fields were dead.
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
 * Idempotent: safe to call multiple times.
 *
 * Optimization 2026-04-19: cheap sentinel check before regex. Most messages
 * have no markers (especially after the no-injection refactor) — skip the
 * regex pass entirely when the marker substring is absent.
 */
const SYNTH_SENTINEL = '<!--ORI_SYNTH-';
export function stripSyntheticFromMessages(messages: Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    if (!m.content.includes(SYNTH_SENTINEL)) continue;
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
 * Current blocks (after preflight removal 2026-04-21):
 *   - proprio (context-status block, appended after user text for highest
 *     salience before generation)
 *
 * All blocks are wrapped with stable markers so the next turn can strip them
 * idempotently via stripSyntheticFromMessages().
 *
 * Precondition: stripSyntheticFromMessages() should have run first this turn.
 *
 * Historical note: preflightBefore / preflightAfter wrappers were removed
 * 2026-04-21 — the preflight retrieval path was killed 2026-04-19 and the
 * wrapper fields had no remaining producers.
 */
export interface TurnSynthetics {
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

  // proprio rides after the user text — closest to generation, highest
  // salience. No leading block today (preflight was the only producer).
  if (!blocks.proprio) return;

  const trailing = '\n\n' + wrapSynthetic(
    'proprio',
    `<system-reminder>\n${blocks.proprio}\n</system-reminder>`,
  );

  messages[lastUserIdx] = {
    ...messages[lastUserIdx],
    content: `${userContent}${trailing}`,
  };
}
