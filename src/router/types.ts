// ── Message types ────────────────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolUseContent | ToolResultContent;

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  meta?: Record<string, unknown>;
}

// ── Tool definition (sent to the model) ─────────────────────────────────────

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

// ── Tool call / result ──────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  isError: boolean;
}

// ── Stream events (yielded by providers) ────────────────────────────────────

export type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; delta: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'done' };

// ── Provider interface ──────────────────────────────────────────────────────

export type ModelSlot = 'primary' | 'reasoning' | 'cheap' | 'bulk';

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;

  stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;

  /** Estimate token count for messages. Exact count is provider-specific. */
  estimateTokens(messages: Message[]): number;
}
