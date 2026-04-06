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
      apiKey: null,          // Suppress env ANTHROPIC_API_KEY fallback
      authToken: accessToken,
      ...(this.baseUrl && { baseURL: this.baseUrl }),
      // OAuth requires the oauth-2025-04-20 beta flag, otherwise Anthropic
      // rejects with "OAuth authentication is currently not supported."
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
    const requestParams: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemArray,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
    };

    if (this.useOAuth) {
      // cch=00000 stays literal — Claude Code 2.1.92 does not compute a
      // replacement. Previous implementation computed xxHash64 which caused
      // Anthropic to reject the billing header. No body signing needed.
    }

    // Build headers for OAuth mode
    const streamOptions: Record<string, unknown> = {};
    if (signal) streamOptions.signal = signal;

    if (this.useOAuth) {
      streamOptions.headers = {
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,adaptive-thinking-2026-01-28,research-preview-2026-02-01',
        'user-agent': 'aries-cli/0.1.0 (external, cli)',
        'x-app': 'cli',
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

        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              const block = event.content_block;
              toolInputBuffers.set(block.id, { name: block.name, json: '' });
              emittedAnyOutput = true;
              yield { type: 'tool_use_start', id: block.id, name: block.name };
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              emittedAnyOutput = true;
              yield { type: 'text', content: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const partial = event.delta.partial_json;
              for (const [id, buf] of toolInputBuffers) {
                buf.json += partial;
                emittedAnyOutput = true;
                yield { type: 'tool_use_delta', id, delta: partial };
              }
            }
          } else if (event.type === 'content_block_stop') {
            for (const [id, buf] of toolInputBuffers) {
              try {
                const input = JSON.parse(buf.json || '{}') as Record<string, unknown>;
                emittedAnyOutput = true;
                yield { type: 'tool_use_end', id, input };
              } catch {
                emittedAnyOutput = true;
                yield { type: 'tool_use_end', id, input: {} };
              }
            }
            toolInputBuffers.clear();
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
