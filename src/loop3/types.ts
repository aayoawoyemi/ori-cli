import type { Message, SystemPromptInput } from '../router/types.js';

export type CodeAction =
  | { kind: 'code'; code: string; timeoutMs?: number; id?: string }
  | { kind: 'final'; value: unknown };

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exception: string | null;
  rejectedReason: string | null;
  timedOut: boolean;
  durationMs: number;
  sayTexts: string[];
  doneValue?: unknown;
  runtime?: {
    footer?: string;
    state?: Record<string, unknown>;
    vars?: Array<{ name: string; summary: string }>;
    plan?: Record<string, unknown>;
    spanner?: Record<string, unknown>;
    telemetry?: Array<Record<string, unknown>>;
    shape?: Record<string, unknown>;
  };
}

export type ActionRef = unknown;

export type ActionEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: 'provider_event'; stage: string; reason?: string; message?: string; elapsedMs?: number; model?: string }
  | { type: 'cutoff_warning'; reason: 'max_tokens' | 'context_window'; message: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'action'; action: CodeAction; ref: ActionRef }
  | { type: 'done' }
  | { type: 'error'; error: unknown; recoverable?: boolean };

export interface ActionAdapter {
  readonly providerName: string;

  stream(
    messages: Message[],
    systemPrompt: SystemPromptInput,
    signal?: AbortSignal,
  ): AsyncGenerator<ActionEvent>;

  buildResultMessage(ref: ActionRef, result: ExecutionResult): Message;
}
