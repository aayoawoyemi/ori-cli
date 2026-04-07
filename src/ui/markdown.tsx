import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Markdown width accounts for the ● prefix (2 chars) + 1 char safety margin.
// Recalculated per render to handle terminal resize.
function getMarkdownWidth(): number {
  return Math.max(40, (process.stdout.columns || 80) - 3);
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

  return <Text>{combined}</Text>;
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
