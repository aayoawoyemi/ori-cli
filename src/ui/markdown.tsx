import React, { useRef, useMemo } from 'react';
import { Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const marked = new Marked(markedTerminal({
  width: process.stdout.columns || 80,
  reflowText: true,
  showSectionPrefix: false,
  tab: 2,
}) as any);

function renderMarkdown(text: string): string {
  if (!text) return '';
  try {
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
 * Streaming markdown with stable prefix memoization.
 *
 * Claude Code pattern: maintain a "stable prefix" — the portion of text
 * up to the last complete markdown block boundary (blank line, heading, etc).
 * Only re-parse the unstable suffix on each new token. The stable part is
 * memoized and never re-rendered.
 *
 * This reduces work from O(total_text) to O(unstable_suffix) per token.
 */
export function StreamingMarkdown({ text }: { text: string }): React.ReactElement {
  const stablePrefixRef = useRef('');
  const stableRenderedRef = useRef('');

  // Find the stable boundary — last double-newline (paragraph break)
  // or last heading. Everything before this is "stable" and won't change
  // as more tokens arrive.
  const lastStableBoundary = findStableBoundary(text);

  const stableText = text.slice(0, lastStableBoundary);
  const unstableText = text.slice(lastStableBoundary);

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
  // Look for the last double-newline (paragraph break)
  // Everything before a paragraph break is complete and won't be affected
  // by tokens arriving after it.
  let boundary = 0;
  let lastDoubleNewline = -1;

  // Search backwards for the last \n\n that isn't inside a code block
  let i = text.length - 1;
  let inCodeBlock = false;

  // Quick scan: find last \n\n
  while (i > 0) {
    if (text[i] === '\n' && text[i - 1] === '\n') {
      lastDoubleNewline = i + 1; // position after the double newline
      break;
    }
    i--;
  }

  if (lastDoubleNewline > 0) {
    // Make sure we're not splitting inside a fenced code block
    const prefix = text.slice(0, lastDoubleNewline);
    const fenceCount = (prefix.match(/^```/gm) || []).length;
    if (fenceCount % 2 === 0) {
      // Even number of fences = not inside a code block
      boundary = lastDoubleNewline;
    }
  }

  return boundary;
}
