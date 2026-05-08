import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { lerpColor } from './spinner.js';

// Markdown width accounts for the ● prefix (2 chars) + 1 char safety margin.
// Recalculated per render to handle terminal resize.
function getMarkdownWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - 6);
}

function renderMarkdown(text: string): string {
  if (!text) return '';
  try {
    const marked = new Marked(markedTerminal({
      width: getMarkdownWidth(),
      reflowText: true,
      showSectionPrefix: false,
      tab: 2,
    }) as any);
    return (marked.parse(text) as string).trimEnd();
  } catch {
    return text;
  }
}

/** Render complete markdown text. */
export function Markdown({ text }: { text: string }): React.ReactElement {
  const rendered = useMemo(() => renderMarkdown(text), [text]);
  return <Text>{rendered}</Text>;
}

/**
 * Streaming markdown with smooth character reveal.
 *
 * Two optimizations work together:
 * 1. Stable prefix memoization — only re-parse the unstable suffix
 * 2. Progressive character reveal — text flows in at ~375 chars/sec
 *    instead of appearing in chunky batches
 *
 * The reveal rate adapts: when the buffer falls behind, it catches up
 * smoothly (doubled step) rather than jumping. When streaming ends,
 * all remaining text is revealed immediately.
 */
export function StreamingMarkdown({ text, isStreaming = true }: { text: string; isStreaming?: boolean }): React.ReactElement {
  const stablePrefixRef = useRef('');
  const stableRenderedRef = useRef('');
  const revealedRef = useRef(0);
  const [revealedCount, setRevealedCount] = useState(0);

  // When streaming ends, reveal everything immediately
  useEffect(() => {
    if (!isStreaming) {
      revealedRef.current = text.length;
      setRevealedCount(text.length);
    }
  }, [isStreaming, text.length]);

  // Progressive reveal interval — runs only while streaming
  useEffect(() => {
    if (!isStreaming) return;
    const interval = setInterval(() => {
      const target = text.length;
      const current = revealedRef.current;
      if (current >= target) return;
      // Base step: ~6 chars per 16ms tick = 375 chars/sec
      // Catch-up: double step when >80 chars behind
      const gap = target - current;
      const step = gap > 80 ? 12 : 6;
      let next = Math.min(current + step, target);
      // Snap forward to next whitespace or end to avoid splitting words mid-render
      while (next < target && text[next] !== ' ' && text[next] !== '\n' && text[next] !== '\t') {
        next++;
      }
      revealedRef.current = next;
      setRevealedCount(next);
    }, 16);
    return () => clearInterval(interval);
  }, [isStreaming, text]);

  // Use the revealed portion of text for rendering
  const visibleText = isStreaming ? text.slice(0, revealedCount) : text;

  // Find the stable boundary — last double-newline (paragraph break)
  const lastStableBoundary = findStableBoundary(visibleText);

  const stableText = visibleText.slice(0, lastStableBoundary);
  const unstableText = visibleText.slice(lastStableBoundary);

  // Only re-render stable prefix if it actually changed
  if (stableText !== stablePrefixRef.current) {
    stablePrefixRef.current = stableText;
    stableRenderedRef.current = stableText ? renderMarkdown(stableText) : '';
  }

  // Always render unstable suffix (it's small and changing)
  const unstableRendered = unstableText ? renderMarkdown(unstableText) : '';

  const combined = stableRenderedRef.current
    ? stableRenderedRef.current + '\n' + unstableRendered
    : unstableRendered;

  // Render the cursor as part of the same Text node so it sits inline at the
  // leading edge of the rendered text — appearing on the same line as the last
  // visible character. Without this nesting it lands on the line below.
  return (
    <Text>
      {combined}
      {isStreaming && <StreamingCursor />}
    </Text>
  );
}

// ── Streaming cursor ──────────────────────────────────────────────────────
// A pulsing ▏ glyph that sits at the leading edge of streaming text. Visual
// purpose: says "new content is arriving here" without competing with the
// rendered markdown. The breathe rate is intentionally slower than the spinner
// (1.6s vs 3s) so the cursor reads as a typing indicator, not a load spinner.
//
// Why a cursor instead of trailing-character fade-in: the streamed text is
// rendered as one `<Text>` containing markdown-converted ANSI escape codes.
// Splitting that string to dim a trailing window requires either parsing ANSI
// (brittle) or rendering the trailing chars as plain text (loses bold/italic
// formatting for the bleeding edge). A cursor sidesteps both — it's a single
// glyph that sits inline without touching the rendered markdown.

const CURSOR_GLYPH = '▏';
const CURSOR_BREATH_MS = 1600;
const CURSOR_FRAME_MS = 33;
const CURSOR_DIM = '#5c4f3e';
const CURSOR_BRIGHT = '#c4a46c';

function StreamingCursor(): React.ReactElement {
  const [, forceRender] = useState(0);
  const originRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => forceRender(n => n + 1), CURSOR_FRAME_MS);
    return () => clearInterval(interval);
  }, []);

  const elapsed = Date.now() - originRef.current;
  const phase = ((elapsed % CURSOR_BREATH_MS) / CURSOR_BREATH_MS) * Math.PI * 2;
  const raw = (Math.sin(phase - Math.PI / 2) + 1) / 2;
  const t = raw * raw * (3 - 2 * raw);
  const color = lerpColor(CURSOR_DIM, CURSOR_BRIGHT, t);

  return <Text color={color}>{CURSOR_GLYPH}</Text>;
}

/** Find the last "stable" boundary in streaming text.
 *  A stable boundary is a point where adding more text after it
 *  won't change how the text before it is parsed. */
function findStableBoundary(text: string): number {
  let boundary = 0;
  let lastDoubleNewline = -1;

  let i = text.length - 1;
  while (i > 0) {
    if (text[i] === '\n' && text[i - 1] === '\n') {
      lastDoubleNewline = i + 1;
      break;
    }
    i--;
  }

  if (lastDoubleNewline > 0) {
    const prefix = text.slice(0, lastDoubleNewline);
    const fenceCount = (prefix.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 0) {
      boundary = lastDoubleNewline;
    }
  }

  return boundary;
}
