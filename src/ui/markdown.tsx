import React from 'react';
import { Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked with terminal renderer
const marked = new Marked(markedTerminal({
  width: process.stdout.columns || 80,
  reflowText: true,
  showSectionPrefix: false,
  tab: 2,
}) as any);

/** Render markdown text as formatted terminal output. */
export function Markdown({ text }: { text: string }): React.ReactElement {
  if (!text) return <Text>{''}</Text>;

  try {
    const rendered = marked.parse(text) as string;
    // marked-terminal returns ANSI strings — use Text to display
    return <Text>{rendered.trimEnd()}</Text>;
  } catch {
    // Fallback: render raw text
    return <Text>{text}</Text>;
  }
}

/** Render streaming markdown — just pass through for now.
 *  V2: implement stable prefix memoization like Claude Code. */
export function StreamingMarkdown({ text }: { text: string }): React.ReactElement {
  // For V0: render the full text each time.
  // Performance is fine for most conversations.
  // Claude Code's stable-prefix optimization is a V2 enhancement.
  return <Markdown text={text} />;
}
