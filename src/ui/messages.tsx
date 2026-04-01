import React from 'react';
import { Box, Text } from 'ink';
import { Markdown, StreamingMarkdown } from './markdown.js';
import { ToolDot } from './spinner.js';

// ── Types for display ───────────────────────────────────────────────────────

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

/** Render the conversation history + streaming response. */
export function Messages({ messages, toolCalls, streamingText, isStreaming }: MessagesProps): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      {messages.map((msg, i) => (
        <MessageRow key={i} message={msg} />
      ))}

      {/* Active tool calls */}
      {toolCalls.map(tc => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}

      {/* Streaming response */}
      {isStreaming && streamingText && (
        <Box flexDirection="column">
          <StreamingMarkdown text={streamingText} />
        </Box>
      )}
    </Box>
  );
}

function MessageRow({ message }: { message: DisplayMessage }): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box>
        <Text bold color="blue">{`> `}</Text>
        <Text bold>{message.text}</Text>
      </Box>
    );
  }

  // Assistant message — render as markdown
  return (
    <Box flexDirection="column">
      <Markdown text={message.text} />
    </Box>
  );
}

function ToolCallRow({ toolCall }: { toolCall: DisplayToolCall }): React.ReactElement {
  return (
    <Box flexDirection="row" gap={1}>
      <ToolDot resolved={toolCall.resolved} isError={toolCall.isError} />
      <Text bold>{toolCall.name}</Text>
      <Text dimColor>{toolCall.summary}</Text>
    </Box>
  );
}
