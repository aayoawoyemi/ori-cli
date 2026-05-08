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

// System prompts can be a legacy flat string or a structured stable/volatile
// pair. Providers that understand prompt caching can mark `stable` cacheable
// and keep `volatile` uncached; simpler providers concatenate the two.
export interface SystemPromptParts {
  stable: string;
  volatile: string;
}

export type SystemPromptInput = string | SystemPromptParts;

// ── Tool definition (sent to the model) ─────────────────────────────────────

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  default?: unknown;
  // JSON Schema constraint fields. Added 2026-04-22 to support the Repl
  // tool's minItems/minLength composition enforcement (plan field minLength,
  // operations array minItems/maxItems, per-op purpose/code minLengths).
  // All three providers (Anthropic/OpenAI-compat/Google) pass input_schema
  // through to upstream APIs unchanged as verified in router/providers/*,
  // so these fields reach provider validation without stripping.
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /**
   * When set, this is a server-executed tool — the provider handles execution
   * internally and no local tool_result round-trip is needed.
   * Anthropic: "web_search_20250305", "url_context_20250305", etc.
   * OpenAI: "web_search_preview", "file_search", etc.
   */
  serverType?: string;
  /** Max uses for server tools (default: unlimited). */
  maxUses?: number;
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
  | {
      type: 'provider_event';
      stage: 'request_start' | 'first_event' | 'backoff' | 'request_error';
      provider: string;
      model: string;
      attempt?: number;
      elapsedMs?: number;
      backoffMs?: number;
      reason?: string;
      message?: string;
      rawEventCount?: number;
      msSinceFirstEvent?: number;
    }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; delta: string }
  | { type: 'tool_use_end'; id: string; input: Record<string, unknown> }
  | { type: 'usage'; inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  // Batch 3 — surfaced when the API stops generation early (max_tokens hit,
  // context window exceeded). The `message` is the human-readable cue the
  // loop injects into conversation as a synthetic continuation marker so
  // the model sees "you got cut off — continue" naturally on the next turn.
  // Pattern lifted from Claude Code's services/api/claude.ts:2266-2292.
  // Behind features.harnessCleanup; legacy code path never emits this.
  | { type: 'thinking'; content: string }
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string }
  | { type: 'done' };

// ── Effort levels (model-thinking depth) ────────────────────────────────────
//
// Defined here (not in router/index.ts) to break a circular import: provider
// modules import EffortLevel for their setEffort() implementation; router/
// index.ts also defines EFFORT_CONFIG keyed by EffortLevel. Without this
// relocation, anthropic.ts → router/index.ts → providers/anthropic.ts cycles
// at module load.
//
// Levels map directly to Anthropic's `output_config.effort` for adaptive
// thinking on Opus 4.6/4.7 + Sonnet 4.6:
//   max     — full reasoning, no constraint
//   xhigh   — Opus 4.7 only; deeper than `high`
//   high    — always thinks, deep reasoning on hard tasks (default)
//   medium  — moderate thinking; may skip on very simple queries
//   low     — minimizes thinking; speed-first
// For OpenAI reasoning models (gpt-5/o3), maps to `reasoning_effort`.
// For Anthropic models without adaptive support (Haiku 4.5, older Sonnet/Opus),
// maps to a legacy budget_tokens via EFFORT_CONFIG in router/index.ts.
export type EffortLevel = 'max' | 'high' | 'medium' | 'low';

// ── Provider interface ──────────────────────────────────────────────────────

export type ModelSlot = 'primary' | 'reasoning' | 'cheap' | 'bulk';

export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;

  stream(
    messages: Message[],
    systemPrompt: SystemPromptInput,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent>;

  /** Estimate token count for messages. Exact count is provider-specific. */
  estimateTokens(messages: Message[]): number;

  /**
   * Set the thinking token budget for the next stream call.
   * 0 = no thinking (fast). >0 = extended thinking with that budget.
   * Only implemented by providers that support extended thinking (Anthropic).
   */
  setThinkingBudget?(budget: number): void;

  /**
   * Set the effort level for the next stream call. Drives adaptive thinking
   * on Anthropic Opus 4.6/4.7 + Sonnet 4.6 (`output_config.effort`) and
   * `reasoning_effort` on OpenAI gpt-5/o3. Providers that don't support
   * effort-driven reasoning ignore this. Optional method.
   */
  setEffort?(effort: EffortLevel): void;

  /**
   * Set the session ID for prompt-cache affinity. Called once at startup
   * after SessionStorage exists; the value flows into prompt_cache_key on
   * OpenAI-compatible requests so consecutive calls within a session land
   * on the same upstream cache shard. Anthropic native is a no-op (the API
   * has no equivalent client-supplied affinity field — caching is purely
   * prefix-based). Optional method: providers that don't care can skip it.
   */
  setSessionId?(id: string): void;
}
