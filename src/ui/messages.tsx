import React from 'react';
import { Box, Text } from 'ink';
import { Markdown, StreamingMarkdown } from './markdown.js';
import { ToolDot } from './spinner.js';
import { figures, colors } from './theme.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  subtype?: 'compact' | 'error' | 'info';
  /** For completed assistant turns: the full interleaved text+tool segments, preserved for display. */
  segments?: StreamSegment[];
}

export interface DisplayToolCall {
  id: string;
  name: string;
  summary: string;
  resolved: boolean;
  isError: boolean;
  resultPreview?: string;
  durationMs?: number;
  /**
   * Inline voice from the tool — Repl's say() output, attributed to this call.
   * Routed by app.tsx setOnSay handler to whichever tool segment is currently
   * unresolved. Rendered below the call header in a dimmed/italic style so it
   * reads as the agent's voice during composed work, not narration between calls.
   */
  says?: string[];
}

/** A segment in the live stream — text and tools interleaved in arrival order. */
export type StreamSegment =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool'; data: DisplayToolCall };

interface MessagesProps {
  messages: DisplayMessage[];
  /** Live stream of the current turn — text and tool calls interleaved. */
  streamSegments: StreamSegment[];
  isStreaming: boolean;
}

const MAX_LIVE_SEGMENTS = 60;
const MAX_RENDERED_COMPLETED_SEGMENTS = 40;
const MAX_RENDERED_TEXT_CHARS = 5000;

function renderTextWindow(text: string, maxChars = MAX_RENDERED_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  const hidden = text.length - maxChars;
  return `[${hidden} chars hidden]\n${text.slice(-maxChars)}`;
}

// ── Messages ────────────────────────────────────────────────────────────────

export function Messages({ messages, streamSegments, isStreaming }: MessagesProps): React.ReactElement {
  const liveHidden = Math.max(0, streamSegments.length - MAX_LIVE_SEGMENTS);
  const visibleLiveSegments = liveHidden > 0 ? streamSegments.slice(-MAX_LIVE_SEGMENTS) : streamSegments;
  return (
    <Box flexDirection="column">
      {(() => {
        const MAX_VISIBLE = 100;
        const hidden = Math.max(0, messages.length - MAX_VISIBLE);
        const visible = hidden > 0 ? messages.slice(-MAX_VISIBLE) : messages;
        return (
          <>
            {hidden > 0 && <Text dimColor>({hidden} earlier messages)</Text>}
            {visible.map((msg, i) => (
              <MessageRow key={hidden + i} message={msg} addMargin={i > 0} />
            ))}
          </>
        );
      })()}

      {/* Live stream: interleaved text blocks and tool calls */}
      {isStreaming && liveHidden > 0 && <Text dimColor>({liveHidden} earlier live events hidden)</Text>}
      {isStreaming && visibleLiveSegments.map((seg, i) => {
        if (seg.type === 'thinking' && seg.content) {
          return (
            <Box key={`t-${i}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
              <Text dimColor italic>{"∴ Thinking..."}</Text>
              <Box paddingLeft={2}>
                <Text dimColor italic>{renderTextWindow(seg.content, 2000)}</Text>
              </Box>
            </Box>
          );
        }
        if (seg.type === 'text' && seg.content) {
          // First text segment in the turn gets the ● prefix
          // Subsequent text segments also get ● — each is a distinct thought
          return <AssistantStreamingMessage key={`s-${i}`} text={renderTextWindow(seg.content)} addMargin={i > 0} />;
        }
        if (seg.type === 'tool') {
          return <ToolCallRow key={seg.data.id} toolCall={seg.data} addMargin={i > 0} />;
        }
        return null;
      })}
    </Box>
  );
}

// ── User Message ────────────────────────────────────────────────────────────

function UserMessage({ text, addMargin }: { text: string; addMargin: boolean }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      marginBottom={1}
      backgroundColor={colors.userMessageBg}
      paddingLeft={1}
      paddingRight={1}
      width="100%"
    >
      <Text color={colors.text}>{text}</Text>
    </Box>
  );
}

// ── Assistant Message ───────────────────────────────────────────────────────

function AssistantMessage({ text, addMargin }: { text: string; addMargin: boolean }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Box width={3} flexShrink={0}>
        <Text color={colors.text}>{figures.dot} </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}

// ── Assistant Streaming ─────────────────────────────────────────────────────

function AssistantStreamingMessage({ text, addMargin }: { text: string; addMargin: boolean }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Box width={3} flexShrink={0}>
        <Text color={colors.text}>{figures.dot} </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <StreamingMarkdown text={text} isStreaming={true} />
      </Box>
    </Box>
  );
}

// ── System Message ──────────────────────────────────────────────────────────

function SystemMessage({ text, subtype, addMargin }: { text: string; subtype?: string; addMargin: boolean }): React.ReactElement {
  if (subtype === 'compact') {
    return (
      <Box marginY={1}>
        <Text dimColor>{figures.compact} {text}</Text>
      </Box>
    );
  }

  if (subtype === 'error') {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
        <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
        <Text color={colors.error}>{text}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
      <Text dimColor>{text}</Text>
    </Box>
  );
}

// ── Message Row Router ──────────────────────────────────────────────────────

function MessageRow({ message, addMargin }: { message: DisplayMessage; addMargin: boolean }): React.ReactElement {
  if (message.role === 'user') {
    return <UserMessage text={message.text} addMargin={addMargin} />;
  }
  if (message.role === 'system') {
    return <SystemMessage text={message.text} subtype={message.subtype} addMargin={addMargin} />;
  }
  // Render completed assistant turns with their full segments (text + tool calls)
  if (message.segments && message.segments.length > 0) {
    const hidden = Math.max(0, message.segments.length - MAX_RENDERED_COMPLETED_SEGMENTS);
    const visibleSegments = hidden > 0 ? message.segments.slice(-MAX_RENDERED_COMPLETED_SEGMENTS) : message.segments;
    return (
      <Box flexDirection="column" marginTop={addMargin ? 1 : 0} marginBottom={1}>
        {hidden > 0 && <Text dimColor>({hidden} earlier turn events hidden)</Text>}
        {visibleSegments.map((seg, i) => {
              if (seg.type === 'thinking' && seg.content) {
                return (
                  <Box key={`ct-${i}`} flexDirection="column" marginTop={i > 0 ? 1 : 0}>
                    <Text dimColor italic>{"∴ Thinking..."}</Text>
                    <Box paddingLeft={2}>
                      <Text dimColor italic>{renderTextWindow(seg.content, 2000)}</Text>
                    </Box>
                  </Box>
                );
              }
              if (seg.type === 'text' && seg.content) {
            return <AssistantMessage key={`seg-${i}`} text={renderTextWindow(seg.content)} addMargin={i > 0} />;
          }
          if (seg.type === 'tool') {
            return <ToolCallRow key={seg.data.id} toolCall={seg.data} addMargin={i > 0} />;
          }
          return null;
        })}
      </Box>
    );
  }
  return <AssistantMessage text={message.text} addMargin={addMargin} />;
}

// ── Diff Preview ───────────────────────────────────────────────────────────

function DiffPreview({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          return (
            <Box key={i} flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text color={colors.success}>{line}</Text>
            </Box>
          );
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
          return (
            <Box key={i} flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text color={colors.error}>{line}</Text>
            </Box>
          );
        }
        if (line.startsWith('@@')) {
          return (
            <Box key={i} flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text color={colors.suggestion}>{line}</Text>
            </Box>
          );
        }
        if (i === 0) {
          return (
            <Box key={i} flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text dimColor>{line}</Text>
            </Box>
          );
        }
        return (
          <Box key={i} flexDirection="row">
            <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
            <Text dimColor>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Tool Call Row ───────────────────────────────────────────────────────────

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallRow({ toolCall, addMargin }: { toolCall: DisplayToolCall; addMargin?: boolean }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Box flexDirection="row" alignItems="flex-start">
        <ToolDot resolved={toolCall.resolved} isError={toolCall.isError} />
        <Text bold color={colors.text}>{toolCall.name}</Text>
        {toolCall.summary && (
          <Text color={colors.dim}> {toolCall.summary}</Text>
        )}
        {toolCall.resolved && toolCall.durationMs !== undefined && (
          <Text color={colors.dim}> ({formatDurationMs(toolCall.durationMs)})</Text>
        )}
      </Box>

      {/*
       * Inline voice — say() output from this Repl call. Renders BEFORE the
       * result preview because says are the agent's communication during the
       * call ("here's what I found / what I'm doing"), while the preview is
       * the raw op log. Gold blockquote prefix (▎) marks them as voice; the
       * gray ⎿ result lines stay visually distinct as plain output.
       * Visible even before resolved — user sees voice live during composed work.
       */}
      {toolCall.says && toolCall.says.length > 0 && (
        <Box flexDirection="column">
          {toolCall.says.map((s, i) => (
            <Box key={`say-${i}`} flexDirection="row">
              <Text color={colors.claude}>{'  '}{figures.blockquote}{'  '}</Text>
              <Text color={colors.text} italic>{s}</Text>
            </Box>
          ))}
        </Box>
      )}

      {toolCall.resolved && toolCall.resultPreview && (() => {
        const preview = renderTextWindow(toolCall.resultPreview, 4000);
        const hasDiff = preview.includes('\n-') || preview.includes('\n+');
        if (hasDiff) {
          // First line is the human summary ("Added 3 lines, removed 1 line"),
          // rest is the raw diff for colorization.
          const newlineIdx = preview.indexOf('\n');
          const summaryLine = newlineIdx > -1 ? preview.slice(0, newlineIdx) : '';
          const diffText = newlineIdx > -1 ? preview.slice(newlineIdx + 1) : preview;
          return (
            <Box flexDirection="column">
              {summaryLine ? (
                <Box flexDirection="row">
                  <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
                  <Text dimColor>{summaryLine}</Text>
                </Box>
              ) : null}
              <DiffPreview text={diffText} />
            </Box>
          );
        }
        return (
          <Box flexDirection="column">
            <Box flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text dimColor>{preview}</Text>
            </Box>
          </Box>
        );
      })()}
    </Box>
  );
}
