import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock } from '../types.js';
import type { ModelConfig, FeaturesConfig } from '../../config/types.js';
import { resolveMaxTokens, resolveThinkingBudget } from '../model-capabilities.js';
import {
  AnthropicLocalOAuthError,
  AnthropicLocalOAuthSource,
  type OAuthCredentials,
} from '../../auth/anthropicLocalOAuth.js';
import { buildBillingHeader } from '../../auth/cch.js';
import { getMessageText } from '../../utils/messages.js';
import { CACHE_PREFIX_BREAK } from '../../prompt.js';

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


  // Cache breakpoint on the last user message (Pi pattern). Tells Anthropic
  // to cache the entire conversation history up to this point. Next turn,
  // only new messages after this point get charged as input. This is the
  // single highest-leverage optimization for token cost.
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      const msg = result[i];
      if (Array.isArray(msg.content)) {
        const lastBlock = msg.content[msg.content.length - 1];
        if (lastBlock && typeof lastBlock === 'object') {
          (lastBlock as any).cache_control = { type: 'ephemeral' };
        }
      } else if (typeof msg.content === 'string') {
        result[i] = {
          role: 'user',
          content: [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }] as any,
        };
      }
      break;
    }
  }

  return result;
}

// Cache breakpoint on the last tool definition (Pi pattern). Tells Anthropic
// to cache system prompt + all tool schemas as a prefix block. Without this,
// ~5K tokens of tool schemas get re-read every turn.
function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
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
  /** Batch 3 — when features.harnessCleanup is true, the constructor uses
   *  the per-model capability table (model-capabilities.ts) instead of the
   *  16K floor, and the stream emits cutoff_warning events on max_tokens
   *  hits. Threaded from ModelRouter (router/index.ts) so the provider
   *  doesn't have to reach into config itself. */
  features?: FeaturesConfig;
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
  /** Batch 3 — captured at construction for the message_delta cutoff_warning
   *  branch. Stored on the instance because the for-await closure inside
   *  stream() can't see the original `options` arg without re-plumbing. */
  private readonly features?: FeaturesConfig;

  constructor(config: ModelConfig, options: AnthropicProviderOptions = {}) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 200_000;
    this.features = options.features;
    // Batch 3 — under harnessCleanup, the model-capabilities table picks
    // a per-model default (Opus 4.7 → 128K) and clamps explicit overrides
    // to the model's API ceiling. Pre-flag behavior is the legacy 16K
    // floor; one-line revert in src/config/defaults.ts:99 swaps back.
    // setMaxTokens()/getMaxTokens() at :312-318 still override at-call.
    this.maxTokens = this.features?.harnessCleanup
      ? resolveMaxTokens(config.model, config.maxTokens)
      : (config.maxTokens ?? 16_384);
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

  /**
   * Temporarily set the per-call max_tokens. Used by cheapCall to cap
   * utility calls (extraction, reflection) at much smaller outputs than
   * the provider's configured default (typically 16k). Caller is responsible
   * for restoring via setMaxTokens(previous).
   */
  setMaxTokens(n: number): void {
    this.maxTokens = Math.max(256, n);
  }

  getMaxTokens(): number {
    return this.maxTokens;
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
    //
    // disable_parallel_tool_use is the structural lever for codemode's thesis:
    // the model emits exactly ONE tool_use block per response. With Repl as
    // the only action verb (A8) and composition examples packed into its
    // description (A9), the model's natural path becomes a single composed
    // Repl call doing N actions via Python control flow — not N separate
    // Repl tool_uses fragmented across the response. Pair with the OpenAI
    // provider's parallel_tool_calls: false for cross-provider coverage.
    //
    // Only set when tools are present — no effect on plain conversational
    // turns and avoids API validation errors on tool-less requests.
    const thinkingBudget = resolveThinkingBudget(this.maxTokens, this._thinkingBudget);

    const requestParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemArray,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && {
        tools: anthropicTools,
        tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true },
      }),
      // Extended thinking: inject budget when > 0. budget_tokens counts toward max_tokens.
      ...(thinkingBudget > 0 && {
        thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget },
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
    } else if (thinkingBudget > 0) {
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

        // Batch 3 — captured stop_reason from message_delta. CC's pattern
        // (services/api/claude.ts:2242) records this on message_delta and
        // surfaces a cutoff_warning before message_stop fires.
        let observedStopReason: string | null = null;
        // Batch 3 (close-out) — count completed content blocks (text or
        // tool_use, NOT thinking). Used to detect the "200 OK, no body"
        // proxy-failure pattern Claude Code guards against in
        // services/api/claude.ts:2350: stream completes without a single
        // content block AND without a stop_reason. We surface that as a
        // cutoff_warning so the loop layer treats it the same way as a
        // max_tokens cutoff (model continues from where it left off).
        let completedContentBlocks = 0;

        // Batch 3 — wrap the stream consumer in try/finally so the
        // toolInputBuffers map is cleared even if the generator is aborted
        // mid-stream (network drop, AbortSignal, downstream throw). Pre-fix
        // the buffer entries leaked into the next request via the closure
        // capture; defensive cleanup keeps memory + state honest.
        try {
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
            // Batch 3 close-out — count non-thinking blocks that completed
            // cleanly. Used by the post-loop guard below to detect "200 OK
            // empty body" proxy failures.
            completedContentBlocks += 1;
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
          } else if (event.type === 'message_delta') {
            // Batch 3 — capture stop_reason here so we can synthesize a
            // cutoff_warning before the done event fires. Pre-fix the
            // stream went silent on max_tokens hits and the model lost
            // ~5-10K input tokens on the inevitable retry. Pattern from
            // Claude Code services/api/claude.ts:2213-2293 — they inject
            // a synthetic assistant message into the stream telling the
            // model "you got cut off, continue from where you left off."
            // The loop layer (src/loop.ts) handles the actual injection
            // when this event arrives; provider just surfaces the signal.
            // Same recovery path for model_context_window_exceeded per
            // CC's note that both = "continue from cutoff" semantically.
            const stopReason = (event as unknown as { delta?: { stop_reason?: string } })
              .delta?.stop_reason;
            if (stopReason) observedStopReason = stopReason;
            if (this.features?.harnessCleanup && stopReason === 'max_tokens') {
              emittedAnyOutput = true;
              yield {
                type: 'cutoff_warning',
                reason: 'max_tokens',
                message:
                  `Response cut off at ${this.maxTokens} output token max. ` +
                  `Continue from where you left off in the next turn.`,
              };
            } else if (
              this.features?.harnessCleanup &&
              stopReason === 'model_context_window_exceeded'
            ) {
              emittedAnyOutput = true;
              yield {
                type: 'cutoff_warning',
                reason: 'context_window',
                message:
                  'Context window exceeded. Continue from where you left off.',
              };
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
            // Batch 3 close-out — stream-no-events guard. Mirrors Claude
            // Code's check at services/api/claude.ts:2350: if the stream
            // completed but produced no completed content blocks AND we
            // didn't capture a stop_reason via message_delta, the proxy
            // returned a 200 with no usable body. Surface as cutoff_warning
            // so the loop layer treats it the same way as max_tokens —
            // injects a continuation marker, model retries cleanly. Without
            // this guard the model just sees an empty assistant turn and
            // gets confused. The check fires AFTER usage is yielded so
            // telemetry still records the cost of the empty response.
            if (
              this.features?.harnessCleanup
              && completedContentBlocks === 0
              && observedStopReason === null
            ) {
              yield {
                type: 'cutoff_warning',
                reason: 'context_window',
                message:
                  'Upstream returned no content blocks (proxy timeout or empty response). ' +
                  'Continue from where you left off.',
              };
            }
            emittedAnyOutput = true;
            yield { type: 'done' };
          }
        }
        } finally {
          // Batch 3 — defensive cleanup. Buffers should already be empty
          // after content_block_stop fires for each tool_use, but stream
          // aborts (network drop, AbortSignal, downstream throw) skip
          // those events. Clearing here prevents partial JSON from
          // re-appearing on the next request via captured closure refs.
          toolInputBuffers.clear();
          indexToToolId.clear();
          thinkingBlockIndices.clear();
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
