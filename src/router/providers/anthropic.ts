import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock } from '../types.js';
import type { ModelConfig } from '../../config/types.js';
import {
  AnthropicLocalOAuthError,
  AnthropicLocalOAuthSource,
  type OAuthCredentials,
} from '../../auth/anthropicLocalOAuth.js';
import { buildBillingHeader } from '../../auth/cch.js';
import { getMessageText } from '../../utils/messages.js';
import { CACHE_PREFIX_BREAK } from '../../prompt.js';

/** Convert our Message format to Anthropic's format. */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content) content.push({ type: 'text', text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }
      }
      if (content.length > 0) {
        result.push({ role: 'assistant', content });
      }
    } else {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                data: block.source.data,
              },
            });
          } else if (block.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            });
          }
        }
        if (content.length > 0) {
          result.push({ role: 'user', content });
        }
      }
    }
  }

  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
}

function splitSystemPromptByCacheBoundary(systemPrompt: string): {
  prefix?: string;
  remainder: string;
} {
  const idx = systemPrompt.indexOf(CACHE_PREFIX_BREAK);
  if (idx === -1) {
    return { remainder: systemPrompt };
  }
  const prefix = systemPrompt.slice(0, idx).trim();
  const remainder = systemPrompt.slice(idx + CACHE_PREFIX_BREAK.length).trim();
  return {
    ...(prefix ? { prefix } : {}),
    remainder: remainder || ' ',
  };
}

function estimateRequestTokens(
  systemArray: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): number {
  let chars = 0;
  for (const block of systemArray) chars += block.text.length;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length + block.name.length;
        else if (block.type === 'tool_result') chars += JSON.stringify(block.content ?? '').length;
      }
    }
  }
  for (const tool of tools) {
    chars += tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.input_schema).length;
  }
  return Math.ceil(chars / 3.5);
}

interface AnthropicProviderOptions {
  allowExperimentalLocalOAuth?: boolean;
  oauthSource?: AnthropicLocalOAuthSource;
  maxRateLimitRetries?: number;
  defaultRateLimitBackoffMs?: number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly contextWindow: number;
  private client: Anthropic;
  private maxTokens: number;
  private useOAuth: boolean;
  private oauthCreds: OAuthCredentials | null = null;
  private oauthSource: AnthropicLocalOAuthSource | null = null;
  private readonly baseUrl?: string;
  private readonly maxRateLimitRetries: number;
  private readonly defaultRateLimitBackoffMs: number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Extended thinking budget (tokens). 0 = no thinking. Set by ModelRouter before each stream call. */
  private _thinkingBudget = 0;

  constructor(config: ModelConfig, options: AnthropicProviderOptions = {}) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 200_000;
    this.maxTokens = config.maxTokens ?? 16_384;
    this.useOAuth = config.auth === 'oauth';
    this.baseUrl = config.baseUrl;
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? 1);
    this.defaultRateLimitBackoffMs = Math.max(1000, options.defaultRateLimitBackoffMs ?? 65_000);
    this.sleepImpl = options.sleepImpl ?? this.defaultSleep;

    if (this.useOAuth) {
      if (!options.allowExperimentalLocalOAuth) {
        throw new Error(
          'Anthropic OAuth mode is disabled. Set experimental.localClaudeSubscription: true to use the local Claude subscription path.',
        );
      }

      this.oauthSource = options.oauthSource ?? new AnthropicLocalOAuthSource();
      try {
        this.oauthCreds = this.oauthSource.loadCredentials();
      } catch (err) {
        throw new Error(this.formatOAuthError('credential load', err));
      }

      this.client = this.createOAuthClient(this.oauthCreds.accessToken);
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
        ...(this.baseUrl && { baseURL: this.baseUrl }),
      });
    }
  }

  private createOAuthClient(accessToken: string): Anthropic {
    return new Anthropic({
      apiKey: null as unknown as string, // suppress ANTHROPIC_API_KEY env fallback
      authToken: accessToken,
      ...(this.baseUrl && { baseURL: this.baseUrl }),
      defaultHeaders: {
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
  }

  private formatOAuthError(stage: string, err: unknown): string {
    if (err instanceof AnthropicLocalOAuthError) {
      return `Anthropic local Claude subscription auth failed during ${stage}: ${err.message}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Anthropic local Claude subscription auth failed during ${stage}: ${message}`;
  }

  private formatRequestError(stage: string, err: unknown): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (this.useOAuth) {
      const suffix = /401|unauthorized/i.test(message)
        ? ' The local token may be expired, the billing header may have drifted, or the local credential store may need to be refreshed.'
        : '';
      return new Error(`Anthropic local Claude subscription request failed during ${stage}: ${message}${suffix}`);
    }
    return new Error(`Anthropic request failed during ${stage}: ${message}`);
  }

  private static asRecord(value: unknown): Record<string, unknown> {
    return (value !== null && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  }

  private getHeaderValue(headers: unknown, name: string): string | undefined {
    if (!headers) return undefined;

    const lower = name.toLowerCase();
    const h = headers as { get?: (key: string) => string | null };
    if (typeof h.get === 'function') {
      const viaGet = h.get(name) ?? h.get(lower);
      if (viaGet) return viaGet;
    }

    const rec = AnthropicProvider.asRecord(headers);
    const raw = rec[name] ?? rec[lower];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') return raw[0];
    return undefined;
  }

  private isRateLimitError(err: unknown): boolean {
    const rec = AnthropicProvider.asRecord(err);
    const status = typeof rec.status === 'number' ? rec.status : undefined;
    if (status === 429) return true;

    const msg = err instanceof Error ? err.message : String(err);
    if (/rate[_\s-]*limit|too many requests|\b429\b/i.test(msg)) return true;

    const maybeError = AnthropicProvider.asRecord(rec.error);
    return typeof maybeError.type === 'string' && maybeError.type.toLowerCase() === 'rate_limit_error';
  }

  private getRateLimitBackoffMs(err: unknown): number {
    const rec = AnthropicProvider.asRecord(err);
    const retryAfter = this.getHeaderValue(rec.headers, 'retry-after');

    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (Number.isFinite(asNum) && asNum > 0) {
        return Math.max(1000, Math.floor(asNum * 1000));
      }

      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        const delta = asDate - Date.now();
        if (delta > 0) return Math.max(1000, delta);
      }
    }

    return this.defaultRateLimitBackoffMs;
  }

  private async defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error('Aborted while waiting for rate limit backoff'));
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };

      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          cleanup();
          reject(new Error('Aborted while waiting for rate limit backoff'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  /** Set the extended thinking token budget. 0 = no thinking (low latency). */
  setThinkingBudget(budget: number): void {
    this._thinkingBudget = Math.max(0, budget);
  }

  /** Ensure OAuth token is fresh. */
  private async ensureToken(): Promise<void> {
    if (!this.useOAuth || !this.oauthCreds || !this.oauthSource) return;

    try {
      const freshCreds = await this.oauthSource.ensureFreshToken(this.oauthCreds);
      if (freshCreds.accessToken !== this.oauthCreds.accessToken || freshCreds.expiresAt !== this.oauthCreds.expiresAt) {
        this.oauthCreds = freshCreds;
        this.client = this.createOAuthClient(freshCreds.accessToken);
      }
    } catch (err) {
      throw new Error(this.formatOAuthError('token refresh', err));
    }
  }

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    await this.ensureToken();

    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    // Build system array. If a cache marker is present, the prefix block
    // (ambient signatures) is marked cacheable and billed at cache rates.
    let systemArray: Anthropic.TextBlockParam[];
    const split = splitSystemPromptByCacheBoundary(systemPrompt);

    if (this.useOAuth) {
      // OAuth mode: inject billing header as first system block
      const firstUserMsg = messages.find(m => m.role === 'user');
      const firstUserText = firstUserMsg ? getMessageText(firstUserMsg) : '';
      const billingHeader = buildBillingHeader(firstUserText);

      systemArray = [{ type: 'text', text: billingHeader }];
      if (split.prefix) {
        systemArray.push(
          { type: 'text', text: split.prefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: split.remainder },
        );
      } else {
        systemArray.push(
          { type: 'text', text: split.remainder, cache_control: { type: 'ephemeral' } },
        );
      }
    } else {
      if (split.prefix) {
        systemArray = [
          { type: 'text', text: split.prefix, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: split.remainder },
        ];
      } else {
        systemArray = [{ type: 'text', text: split.remainder }];
      }
    }

    // Build request params
    const requestParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemArray,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
      // Extended thinking: inject budget when > 0. budget_tokens counts toward max_tokens.
      ...(this._thinkingBudget > 0 && {
        thinking: { type: 'enabled' as const, budget_tokens: this._thinkingBudget },
      }),
    } as Anthropic.MessageCreateParams;

    if (this.useOAuth) {
      // cch=00000 stays literal — Claude Code 2.1.92 does not compute a
      // replacement. Previous implementation computed xxHash64 which caused
      // Anthropic to reject the billing header. No body signing needed.
    }

    // Build headers
    const streamOptions: Record<string, unknown> = {};
    if (signal) streamOptions.signal = signal;

    if (this.useOAuth) {
      // OAuth mode: static beta list already includes adaptive-thinking-2026-01-28.
      // context-1m is only added when the actual payload approaches the 200k
      // window. Adding it unconditionally for 1M-model shortcuts triggers
      // Anthropic's "Extra usage is required for long context requests" 429
      // on Max plans, even on short messages (anthropics/claude-code#39841).
      const betas = [
        'claude-code-20250219',
        'oauth-2025-04-20',
        'adaptive-thinking-2026-01-28',
        'research-preview-2026-02-01',
      ];
      if (this.contextWindow > 200_000) {
        const estimatedTokens = estimateRequestTokens(systemArray, anthropicMessages, anthropicTools);
        if (estimatedTokens > 180_000) {
          betas.push('context-1m-2025-08-07');
        }
      }
      streamOptions.headers = {
        'anthropic-beta': betas.join(','),
        'user-agent': 'aries-cli/0.1.0 (external, cli)',
        'x-app': 'cli',
      };
    } else if (this._thinkingBudget > 0) {
      // API key mode: add extended thinking beta only when thinking is active
      streamOptions.headers = {
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
      };
    }

    let attempt = 0;
    while (true) {
      const toolInputBuffers = new Map<string, { name: string; json: string }>();
      let emittedAnyOutput = false;

      try {
        const stream = this.client.messages.stream(
          requestParams,
          streamOptions as Anthropic.RequestOptions,
        );

        // Track block types by stream index so we route deltas and stop events
        // to the right buffer. Thinking blocks are skipped entirely.
        const thinkingBlockIndices = new Set<number>();
        // Map stream index → tool_use id, so input_json_delta goes to the right buffer
        const indexToToolId = new Map<number, string>();

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const cb = event.content_block as { type: string; id?: string; name?: string };
            if (cb.type === 'thinking') {
              thinkingBlockIndices.add(event.index);
            } else if (cb.type === 'tool_use' && cb.id && cb.name) {
              toolInputBuffers.set(cb.id, { name: cb.name, json: '' });
              indexToToolId.set(event.index, cb.id);
              emittedAnyOutput = true;
              yield { type: 'tool_use_start', id: cb.id, name: cb.name };
            }
          } else if (event.type === 'content_block_delta') {
            if (thinkingBlockIndices.has(event.index)) continue;
            if (event.delta.type === 'text_delta') {
              emittedAnyOutput = true;
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const partial = event.delta.partial_json;
              // Route delta to the correct tool buffer by stream index
              const toolId = indexToToolId.get(event.index);
              if (toolId) {
                const buf = toolInputBuffers.get(toolId);
                if (buf) {
                  buf.json += partial;
                  emittedAnyOutput = true;
                  yield { type: 'tool_use_delta', id: toolId, delta: partial };
                }
              }
            }
          } else if (event.type === 'content_block_stop') {
            if (thinkingBlockIndices.has(event.index)) {
              thinkingBlockIndices.delete(event.index);
              continue;
            }
            // Finalize only the tool buffer for this block index
            const toolId = indexToToolId.get(event.index);
            if (toolId) {
              const buf = toolInputBuffers.get(toolId);
              if (buf) {
                try {
                  const input = JSON.parse(buf.json || '{}') as Record<string, unknown>;
                  emittedAnyOutput = true;
                  yield { type: 'tool_use_end', id: toolId, input };
                } catch {
                  emittedAnyOutput = true;
                  yield { type: 'tool_use_end', id: toolId, input: {} };
                }
                toolInputBuffers.delete(toolId);
              }
              indexToToolId.delete(event.index);
            }
          } else if (event.type === 'message_stop') {
            const finalMessage = await stream.finalMessage();
            emittedAnyOutput = true;
            const usage = finalMessage.usage as unknown as Record<string, number>;
            yield {
              type: 'usage',
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.input_tokens + usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            };
            emittedAnyOutput = true;
            yield { type: 'done' };
          }
        }

        return;
      } catch (err) {
        const canRetry =
          this.isRateLimitError(err)
          && !emittedAnyOutput
          && attempt < this.maxRateLimitRetries
          && !(signal?.aborted);

        if (!canRetry) {
          if (this.isRateLimitError(err) && attempt > 0) {
            const msg = err instanceof Error ? err.message : String(err);
            throw this.formatRequestError('stream execution', `rate limit persisted after ${attempt} retry attempt(s): ${msg}`);
          }
          throw this.formatRequestError('stream execution', err);
        }

        const backoffMs = this.getRateLimitBackoffMs(err);
        try {
          await this.sleepImpl(backoffMs, signal);
        } catch (sleepErr) {
          throw this.formatRequestError('rate-limit backoff', sleepErr);
        }

        attempt += 1;
      }
    }
  }

  estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') chars += block.text.length;
          else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length;
          else if (block.type === 'tool_result') chars += block.content.length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}
