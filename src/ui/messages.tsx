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
}

export interface DisplayToolCall {
  id: string;
  name: string;
  summary: string;
  resolved: boolean;
  isError: boolean;
  resultPreview?: string;
  durationMs?: number;
}

interface MessagesProps {
  messages: DisplayMessage[];
  toolCalls: DisplayToolCall[];
  streamingText: string;
  isStreaming: boolean;
}

// ── Messages ────────────────────────────────────────────────────────────────

export function Messages({ messages, toolCalls, streamingText, isStreaming }: MessagesProps): React.ReactElement {
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

      {toolCalls.map(tc => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}

      {isStreaming && streamingText && (
        <AssistantStreamingMessage text={streamingText} />
      )}
    </Box>
  );
}

// ── User Message ────────────────────────────────────────────────────────────
// Claude Code: full-width background fill, no prefix dot, no ❯.

function UserMessage({ text, addMargin }: { text: string; addMargin: boolean }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      backgroundColor={colors.userMessageBg}
      paddingRight={1}
      width="100%"
    >
      <Text color={colors.text}>{text}</Text>
    </Box>
  );
}

// ── Assistant Message ───────────────────────────────────────────────────────
// Claude Code: ⏺ dot prefix, then markdown body.

function AssistantMessage({ text, addMargin }: { text: string; addMargin: boolean }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
      <Box minWidth={2} flexShrink={0}>
        <Text color={colors.text}>{figures.dot}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
}

// ── Assistant Streaming ─────────────────────────────────────────────────────

function AssistantStreamingMessage({ text }: { text: string }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box minWidth={2} flexShrink={0}>
        <Text color={colors.text}>{figures.dot}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <StreamingMarkdown text={text} />
      </Box>
    </Box>
  );
}

// ── System Message ──────────────────────────────────────────────────────────
// Compact boundary: ✻ Conversation compacted
// Error: red text with ⎿ prefix
// Info: dim text with ⎿ prefix

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

  // Default info
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
        // First line (summary) or context lines
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
// Claude Code: ⏺ (blinking) ToolName(summary)
//              ⎿  result preview (when resolved)

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallRow({ toolCall }: { toolCall: DisplayToolCall }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* Header: dot + tool name + args + duration */}
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

      {/* Result preview with ⎿ prefix */}
      {toolCall.resolved && toolCall.resultPreview && (
        <Box flexDirection="column">
          {toolCall.resultPreview.includes('\n-') || toolCall.resultPreview.includes('\n+') ? (
            <DiffPreview text={toolCall.resultPreview} />
          ) : (
            <Box flexDirection="row">
              <Text dimColor>{'  '}{figures.toolResult}{'  '}</Text>
              <Text dimColor>{toolCall.resultPreview}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
