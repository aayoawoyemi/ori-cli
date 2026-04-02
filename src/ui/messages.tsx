import React from 'react';
import { Box, Text } from 'ink';
import { Markdown, StreamingMarkdown } from './markdown.js';
import { ToolDot } from './spinner.js';
import { figures, colors } from './theme.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface DisplayMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface DisplayToolCall {
  id: string;
  name: string;
  summary: string;
  resolved: boolean;
  isError: boolean;
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
      {messages.map((msg, i) => (
        <MessageRow key={i} message={msg} addMargin={i > 0} />
      ))}

      {toolCalls.map(tc => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}

      {isStreaming && streamingText && (
        <Box flexDirection="column" marginTop={1}>
          <StreamingMarkdown text={streamingText} />
        </Box>
      )}
    </Box>
  );
}

// ── Message Row ─────────────────────────────────────────────────────────────

function MessageRow({ message, addMargin }: { message: DisplayMessage; addMargin: boolean }): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box flexDirection="row" marginTop={addMargin ? 1 : 0}>
        <Text color={colors.subtle}>{figures.pointer} </Text>
        <Text>{message.text}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={addMargin ? 1 : 0}>
      <Markdown text={message.text} />
    </Box>
  );
}

// ── Tool Call Row ───────────────────────────────────────────────────────────

function ToolCallRow({ toolCall }: { toolCall: DisplayToolCall }): React.ReactElement {
  return (
    <Box flexDirection="row" alignItems="flex-start">
      <ToolDot resolved={toolCall.resolved} isError={toolCall.isError} />
      <Text bold>{toolCall.name}</Text>
      {toolCall.summary && (
        <Text dimColor> ({toolCall.summary})</Text>
      )}
    </Box>
  );
}
