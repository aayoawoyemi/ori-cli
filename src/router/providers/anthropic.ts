import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock, SystemPromptInput } from '../types.js';
import type { ModelConfig, FeaturesConfig, CacheConfig } from '../../config/types.js';
import { resolveMaxTokens, resolveThinkingBudget, supportsAdaptiveThinking } from '../model-capabilities.js';
import type { EffortLevel } from '../types.js';
import {
  AnthropicLocalOAuthError,
  AnthropicLocalOAuthSource,
  type OAuthCredentials,
} from '../../auth/anthropicLocalOAuth.js';
import { buildBillingHeader } from '../../auth/cch.js';
import { getMessageText } from '../../utils/messages.js';
import { sanitizeMessages, sanitizeSystemPrompt } from '../../utils/sanitize.js';
import { splitSystemPromptInput } from '../../prompt.js';
import {
  buildCacheMarker,
  resolveCacheRetention,
  type CacheControlMarker,
  type CacheRetention,
} from '../cache.js';

function toAnthropicMessages(
  messages: Message[],
  marker: CacheControlMarker | null,
): Anthropic.MessageParam[] {
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
  //
  // When marker is null (retention='none'), skip the breakpoint entirely —
  // the API treats absence of cache_control as opt-out, exactly what we want.
  // The `as any` cast is required because `@anthropic-ai/sdk` v0.52.0 types
  // CacheControlEphemeral as `{ type: 'ephemeral' }` only — `ttl: '1h'` is in
  // the beta path. The wire format accepts it when the extended-cache-ttl
  // beta header is set (added in stream() below for retention='long').
  if (marker !== null) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user') {
        const msg = result[i];
        if (Array.isArray(msg.content)) {
          const lastBlock = msg.content[msg.content.length - 1];
          if (lastBlock && typeof lastBlock === 'object') {
            (lastBlock as any).cache_control = marker;
          }
        } else if (typeof msg.content === 'string') {
          result[i] = {
            role: 'user',
            content: [{ type: 'text', text: msg.content, cache_control: marker } as any],
          };
        }
        break;
      }
    }
  }

  return result;
}

// Cache breakpoint on the last tool definition (Pi pattern). Tells Anthropic
// to cache system prompt + all tool schemas as a prefix block. Without this,
// ~5K tokens of tool schemas get re-read every turn.
//
// marker=null (retention='none') skips the breakpoint and tools schemas
// roundtrip uncached every turn. Used for cost-instrumented runs.
function toAnthropicTools(
  tools: ToolDefinition[],
  marker: CacheControlMarker | null,
): Anthropic.Tool[] {
  return tools.map((t, i) => {
    const base = {
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    };
    if (marker !== null && i === tools.length - 1) {
      // Same `as any` rationale as above — non-beta SDK type doesn't
      // include `ttl` but the wire accepts it under the beta header.
      return { ...base, cache_control: marker as any };
    }
    return base;
  });
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
  /** Prompt-cache retention policy. Threaded from ModelRouter; resolved
   *  through ARIES_CACHE_RETENTION env override at construction time so
   *  a setter isn't needed for mid-session changes. */
  cache?: CacheConfig;
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
  /**
   * Effort level for the next stream call. Drives adaptive thinking on Opus
   * 4.6/4.7 + Sonnet 4.6 (`output_config.effort`). Set by ModelRouter alongside
   * setThinkingBudget. Default 'high' matches the router's default — guarantees
   * the model always thinks when adaptive is in use.
   */
  private _effort: EffortLevel = 'high';
  /** Batch 3 — captured at construction for the message_delta cutoff_warning
   *  branch. Stored on the instance because the for-await closure inside
   *  stream() can't see the original `options` arg without re-plumbing. */
  private readonly features?: FeaturesConfig;
  /**
   * Resolved retention tier. ENV beats config beats default. Drives the
   * cache_control marker shape (5min vs 1h vs none) AND the beta header
   * ('extended-cache-ttl-2025-04-11' for 1h). Captured at construction so
   * stream() doesn't redo the resolution on every call.
   */
  private readonly cacheRetention: CacheRetention;

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
    // resolveCacheRetention also reads ARIES_CACHE_RETENTION /
    // PI_CACHE_RETENTION env so a session can flip retention without
    // touching YAML — mirrors pi's affordance.
    this.cacheRetention = resolveCacheRetention(options.cache?.retention);
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

    const capHeadlessBackoff = (ms: number): number => {
      const envCap = Number(process.env.ARIES_HEADLESS_RATE_LIMIT_BACKOFF_CAP_MS ?? '');
      const cap = Number.isFinite(envCap) && envCap > 0
        ? envCap
        // Headless is measurement/substrate mode. A long OAuth retry-after
        // should become a visible failed run, not an apparently-dead agent
        // that the outer bench kills five minutes later with tokens=0.
        : process.env.ARIES_HEADLESS === '1'
          ? 15_000
          : Infinity;
      return Math.min(ms, cap);
    };

    if (retryAfter) {
      const asNum = Number(retryAfter);
      if (Number.isFinite(asNum) && asNum > 0) {
        return capHeadlessBackoff(Math.max(1000, Math.floor(asNum * 1000)));
      }

      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        const delta = asDate - Date.now();
        if (delta > 0) return capHeadlessBackoff(Math.max(1000, delta));
      }
    }

    return capHeadlessBackoff(this.defaultRateLimitBackoffMs);
  }

  private getFirstEventTimeoutMs(): number {
    const raw = process.env.ARIES_PROVIDER_FIRST_EVENT_TIMEOUT_MS;
    if (raw !== undefined) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    // Headless has no live UI and no human-visible stream while waiting.
    // Without this watchdog an OAuth/provider stall logs only meta+user
    // until an outer harness SIGKILLs the process, which erases the cause.
    return process.env.ARIES_HEADLESS === '1' ? 60_000 : 0;
  }

  private getStreamIdleTimeoutMs(): number {
    const raw = process.env.ARIES_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
    if (raw !== undefined) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    // The first-event watchdog only proves the HTTP stream opened. In
    // headless/bench mode a stream can then stall before text, usage, or stop;
    // fail it explicitly instead of letting an outer harness SIGKILL it.
    return process.env.ARIES_HEADLESS === '1' ? 90_000 : 0;
  }

  private getStreamMaxDurationMs(): number {
    const raw = process.env.ARIES_PROVIDER_STREAM_MAX_DURATION_MS;
    if (raw !== undefined) {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
    // Independent of idle timeout: a stream can keep receiving raw events
    // without producing model-visible text/thinking/usage. In headless mode
    // surface that as a provider error before the outer bench SIGKILLs us.
    return process.env.ARIES_HEADLESS === '1' ? 180_000 : 0;
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
   * Set the effort level for the next stream call. Drives adaptive thinking's
   * `output_config.effort`. Ignored when the model doesn't support adaptive
   * (legacy budget mode used instead).
   */
  setEffort(effort: EffortLevel): void {
    this._effort = effort;
  }

  /**
   * No-op for Anthropic native — there's no client-supplied session-affinity
   * field on the Messages API. Caching is purely prefix-based; cache_control
   * markers + a stable system-prompt prefix are sufficient. Method exists
   * solely to satisfy the optional ModelProvider.setSessionId interface
   * shape so ModelRouter.setSessionId can fan out unconditionally.
   */
  setSessionId(_id: string): void {
    // intentionally empty
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
    systemPrompt: SystemPromptInput,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    await this.ensureToken();

    // Sanitize unpaired UTF-16 surrogates BEFORE any downstream serialization.
    // Web fetches, file reads, or model token-boundary cuts can leave half a
    // surrogate pair in a string; JSON.stringify will emit it; Anthropic's
    // parser rejects with `invalid_request_error: invalid high surrogate`.
    // See src/utils/sanitize.ts header for full rationale.
    messages = sanitizeMessages(messages);
    const systemParts = splitSystemPromptInput(systemPrompt);
    const stableSystemPrompt = sanitizeSystemPrompt(systemParts.stable);
    const volatileSystemPrompt = sanitizeSystemPrompt(systemParts.volatile);

    // Build the cache marker once per stream call. Anthropic native
    // supports the long-TTL extension (ttl: '1h') so supportsLongTtl=true.
    // Returns null when retention='none' — then helpers skip emission.
    const cacheMarker = buildCacheMarker(this.cacheRetention, true);

    const anthropicMessages = toAnthropicMessages(messages, cacheMarker);
    const anthropicTools = toAnthropicTools(tools, cacheMarker);

    // Build system array. If a cache marker is present, the prefix block
    // (ambient signatures) is marked cacheable and billed at cache rates.
    // marker=null path drops the cache_control field entirely so the
    // system prompt round-trips uncached every turn (retention='none').
    let systemArray: Anthropic.TextBlockParam[];
    const split = {
      ...(stableSystemPrompt ? { prefix: stableSystemPrompt } : {}),
      remainder: volatileSystemPrompt || ' ',
    };

    // Helper to attach cache_control via cast — same SDK type-vs-wire
    // divergence rationale as toAnthropicMessages above.
    const withCache = (block: Anthropic.TextBlockParam): Anthropic.TextBlockParam => {
      if (cacheMarker === null) return block;
      return { ...block, cache_control: cacheMarker as any };
    };

    if (this.useOAuth) {
      // OAuth mode: inject billing header as first system block
      const firstUserMsg = messages.find(m => m.role === 'user');
      const firstUserText = firstUserMsg ? getMessageText(firstUserMsg) : '';
      const billingHeader = buildBillingHeader(firstUserText);

      systemArray = [{ type: 'text', text: billingHeader }];
      if (split.prefix) {
        systemArray.push(
          withCache({ type: 'text', text: split.prefix }),
          { type: 'text', text: split.remainder },
        );
      } else {
        systemArray.push(
          withCache({ type: 'text', text: split.remainder }),
        );
      }
    } else {
      if (split.prefix) {
        systemArray = [
          withCache({ type: 'text', text: split.prefix }),
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
    // ── Thinking config: adaptive vs legacy fork ────────────────────────────
    //
    // Adaptive thinking (`thinking: {type: 'adaptive', display: 'summarized'}`
    // + `output_config: {effort}`) is the new shape for Opus 4.6/4.7 + Sonnet
    // 4.6. Two reasons it's load-bearing:
    //
    //  1. **Interleaved thinking auto-enabled.** Adaptive turns on inter-tool
    //     reasoning automatically — model thinks BETWEEN tool calls, not just
    //     at start of turn. Legacy `enabled+budget_tokens` on Opus 4.6 has
    //     interleaved DISABLED (per Anthropic docs); on Opus 4.7 it's outright
    //     rejected with a 400.
    //
    //  2. **`display: 'summarized'` makes thinking content visible on Opus 4.7.**
    //     4.7's default `display` is `'omitted'` — thinking blocks come back
    //     with empty `thinking` field. The "two-line thinking" symptom maps
    //     exactly here: thinking IS happening, the API just isn't sending
    //     the content back. Explicit `summarized` opts in.
    //
    // Models without adaptive support (Haiku 4.5, older Sonnet/Opus) keep the
    // legacy `enabled+budget_tokens` shape — adaptive is rejected on those.
    //
    // SDK 0.52.0 doesn't model adaptive yet — `as any` cast is required on the
    // request params. Same pattern as the cache_control casts at L95/L100.
    const adaptive = supportsAdaptiveThinking(this.model);
    const thinkingBudget = adaptive ? 0 : resolveThinkingBudget(this.maxTokens, this._thinkingBudget);

    const requestParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemArray,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && {
        tools: anthropicTools,
        tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true },
      }),
      ...(adaptive
        ? {
            // Adaptive thinking — model self-regulates depth via effort.
            // Cast required: SDK 0.52.0 only types `enabled`/`disabled`.
            thinking: { type: 'adaptive', display: 'summarized' } as unknown as Anthropic.ThinkingConfigParam,
            output_config: { effort: this._effort },
          }
        : thinkingBudget > 0 && {
            // Legacy: budget-cap thinking. Used for Haiku 4.5 + older models
            // that don't accept adaptive. budget_tokens counts toward max_tokens.
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

    // Extended-cache-ttl beta — required when emitting `ttl: '1h'` on the
    // cache_control marker. Without this header the wire field is silently
    // dropped (markers fall back to 5min). Header name confirmed from SDK
    // beta enum in @anthropic-ai/sdk/resources/beta/beta.d.ts.
    const needsLongTtlBeta = this.cacheRetention === 'long';

    if (this.useOAuth) {
      // OAuth mode: static beta list. Per Anthropic docs (May 2026), adaptive
      // thinking does NOT require a beta header — it's GA on Opus 4.6/4.7 +
      // Sonnet 4.6 directly. Previously we shipped 'adaptive-thinking-2026-01-28'
      // which was the server-side translator from legacy → adaptive; now that
      // we send adaptive directly, the translator is moot.
      //
      // context-1m is only added when the actual payload approaches the 200k
      // window. Adding it unconditionally for 1M-model shortcuts triggers
      // Anthropic's "Extra usage is required for long context requests" 429
      // on Max plans, even on short messages (anthropics/claude-code#39841).
      const betas = [
        'claude-code-20250219',
        'oauth-2025-04-20',
        'research-preview-2026-02-01',
      ];
      if (this.contextWindow > 200_000) {
        const estimatedTokens = estimateRequestTokens(systemArray, anthropicMessages, anthropicTools);
        if (estimatedTokens > 180_000) {
          betas.push('context-1m-2025-08-07');
        }
      }
      if (needsLongTtlBeta) betas.push('extended-cache-ttl-2025-04-11');
      streamOptions.headers = {
        'anthropic-beta': betas.join(','),
        'user-agent': 'aries-cli/0.1.0 (external, cli)',
        'x-app': 'cli',
      };
    } else {
      // API key mode: build beta list dynamically. Adaptive thinking doesn't
      // need a beta header (auto-enables interleaved thinking internally), so
      // we no longer ship 'interleaved-thinking-2025-05-14'. Adaptive-capable
      // models get inter-tool reasoning for free; legacy-budget models on
      // Haiku 4.5 + older Sonnets don't support interleaved at all per the
      // Anthropic docs, so the header was a no-op there too.
      const betas: string[] = [];
      if (needsLongTtlBeta) betas.push('extended-cache-ttl-2025-04-11');
      if (betas.length > 0) {
        streamOptions.headers = {
          'anthropic-beta': betas.join(','),
        };
      }
    }

    let attempt = 0;
    while (true) {
      const toolInputBuffers = new Map<string, { name: string; json: string }>();
      let emittedAnyOutput = false;
      const requestStartedAt = Date.now();
      const firstEventTimeoutMs = this.getFirstEventTimeoutMs();
      const streamIdleTimeoutMs = this.getStreamIdleTimeoutMs();
      const streamMaxDurationMs = this.getStreamMaxDurationMs();
      const debugStream = process.env.ARIES_PROVIDER_DEBUG_STREAM_EVENTS === '1';
      let rawEventCount = 0;
      let firstEventAt = 0;
      let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
      let streamIdleTimer: ReturnType<typeof setTimeout> | null = null;
      let streamDurationTimer: ReturnType<typeof setTimeout> | null = null;
      let firstEventTimedOut = false;
      let streamIdleTimedOut = false;
      let streamDurationTimedOut = false;
      let firstRawEventSeen = false;
      let relayAbort: (() => void) | null = null;
      const requestAbort = firstEventTimeoutMs > 0 || streamIdleTimeoutMs > 0 || streamMaxDurationMs > 0
        ? new AbortController()
        : null;

      const clearFirstEventWatchdog = () => {
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
      };

      const clearStreamIdleWatchdog = () => {
        if (streamIdleTimer) {
          clearTimeout(streamIdleTimer);
          streamIdleTimer = null;
        }
      };

      const clearStreamDurationWatchdog = () => {
        if (streamDurationTimer) {
          clearTimeout(streamDurationTimer);
          streamDurationTimer = null;
        }
      };

      const armStreamIdleWatchdog = () => {
        if (!requestAbort || streamIdleTimeoutMs <= 0) return;
        clearStreamIdleWatchdog();
        streamIdleTimer = setTimeout(() => {
          streamIdleTimedOut = true;
          requestAbort.abort(new Error(
            `No ${this.name} stream event for ${streamIdleTimeoutMs}ms after stream opened`,
          ));
        }, streamIdleTimeoutMs);
      };

      const cleanupRequestWatchdogs = () => {
        clearFirstEventWatchdog();
        clearStreamIdleWatchdog();
        clearStreamDurationWatchdog();
        if (signal && relayAbort) {
          signal.removeEventListener('abort', relayAbort);
          relayAbort = null;
        }
      };

      const eventDiagnostics = () => ({
        rawEventCount,
        msSinceFirstEvent: firstEventAt > 0 ? Date.now() - firstEventAt : 0,
      });

      try {
        yield {
          type: 'provider_event',
          stage: 'request_start',
          provider: this.name,
          model: this.model,
          attempt,
        };

        if (requestAbort) {
          if (signal?.aborted) {
            requestAbort.abort(signal.reason ?? new Error('Upstream signal aborted before provider request'));
          } else if (signal) {
            relayAbort = () => requestAbort.abort(signal.reason ?? new Error('Upstream signal aborted'));
            signal.addEventListener('abort', relayAbort, { once: true });
          }
          if (firstEventTimeoutMs > 0) {
            firstEventTimer = setTimeout(() => {
              firstEventTimedOut = true;
              requestAbort.abort(new Error(
                `No ${this.name} stream event after ${firstEventTimeoutMs}ms`,
              ));
            }, firstEventTimeoutMs);
          }
          if (streamMaxDurationMs > 0) {
            streamDurationTimer = setTimeout(() => {
              streamDurationTimedOut = true;
              requestAbort.abort(new Error(
                `${this.name} stream exceeded ${streamMaxDurationMs}ms wall-clock`,
              ));
            }, streamMaxDurationMs);
          }
          armStreamIdleWatchdog();
        }

        const effectiveStreamOptions = requestAbort
          ? { ...streamOptions, signal: requestAbort.signal }
          : streamOptions;
        const stream = this.client.messages.stream(
          requestParams,
          effectiveStreamOptions as Anthropic.RequestOptions,
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
          rawEventCount += 1;
          if (firstEventAt === 0) firstEventAt = Date.now();
          if (debugStream) {
            const evAny = event as { type: string; delta?: { type?: string }; content_block?: { type?: string } };
            const sub = evAny.delta?.type ?? evAny.content_block?.type;
            process.stderr.write(
              `[anthropic-stream] +${Date.now() - requestStartedAt}ms type=${evAny.type}${sub ? ` sub=${sub}` : ''}\n`,
            );
          }
          armStreamIdleWatchdog();
          if (!firstRawEventSeen) {
            firstRawEventSeen = true;
            clearFirstEventWatchdog();
            yield {
              type: 'provider_event',
              stage: 'first_event',
              provider: this.name,
              model: this.model,
              attempt,
              elapsedMs: Date.now() - requestStartedAt,
            };
          }
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
            if (thinkingBlockIndices.has(event.index)) {
              // 2026-05-01: Yield thinking content to the UI instead of
              // silently dropping it. The continue stays so text_delta/tool
              // logic below doesn't fire for thinking blocks.
              const delta = event.delta as { type?: string; thinking?: string };
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                yield { type: 'thinking', content: delta.thinking };
              }
              continue;
            }
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
              totalTokens: usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0),
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
          cleanupRequestWatchdogs();
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
        cleanupRequestWatchdogs();

        if (firstEventTimedOut && !firstRawEventSeen) {
          const message = `No ${this.name} stream event after ${firstEventTimeoutMs}ms`;
          yield {
            type: 'provider_event',
            stage: 'request_error',
            provider: this.name,
            model: this.model,
            attempt,
            elapsedMs: Date.now() - requestStartedAt,
            reason: 'first_event_timeout',
            message,
            ...eventDiagnostics(),
          };
          throw this.formatRequestError('stream first-event timeout', message);
        }

        if (streamDurationTimedOut) {
          const message = `${this.name} stream exceeded ${streamMaxDurationMs}ms wall-clock`;
          yield {
            type: 'provider_event',
            stage: 'request_error',
            provider: this.name,
            model: this.model,
            attempt,
            elapsedMs: Date.now() - requestStartedAt,
            reason: 'stream_duration_timeout',
            message,
            ...eventDiagnostics(),
          };
          throw this.formatRequestError('stream duration timeout', message);
        }

        if (streamIdleTimedOut) {
          const message = `No ${this.name} stream event for ${streamIdleTimeoutMs}ms after stream opened`;
          yield {
            type: 'provider_event',
            stage: 'request_error',
            provider: this.name,
            model: this.model,
            attempt,
            elapsedMs: Date.now() - requestStartedAt,
            reason: 'stream_idle_timeout',
            message,
            ...eventDiagnostics(),
          };
          throw this.formatRequestError('stream idle timeout', message);
        }

        const canRetry =
          this.isRateLimitError(err)
          && !emittedAnyOutput
          && attempt < this.maxRateLimitRetries
          && !(signal?.aborted);

        if (!canRetry) {
          const msg = err instanceof Error ? err.message : String(err);
          yield {
            type: 'provider_event',
            stage: 'request_error',
            provider: this.name,
            model: this.model,
            attempt,
            elapsedMs: Date.now() - requestStartedAt,
            reason: this.isRateLimitError(err) ? 'rate_limit' : 'error',
            message: msg.slice(0, 1000),
            ...eventDiagnostics(),
          };
          if (this.isRateLimitError(err) && attempt > 0) {
            throw this.formatRequestError('stream execution', `rate limit persisted after ${attempt} retry attempt(s): ${msg}`);
          }
          throw this.formatRequestError('stream execution', err);
        }

        const backoffMs = this.getRateLimitBackoffMs(err);
        yield {
          type: 'provider_event',
          stage: 'backoff',
          provider: this.name,
          model: this.model,
          attempt,
          backoffMs,
          reason: 'rate_limit',
          message: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        };
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
