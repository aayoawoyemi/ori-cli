/**
 * src/router/cache.ts — Prompt-cache marker resolution + OpenAI-shape injection.
 *
 * One source of truth for every cache_control / prompt_cache_key decision
 * across providers. Keeps anthropic.ts and openai-compatible.ts from drifting
 * apart on what "retention=long" actually means on the wire.
 *
 * ── Three retention tiers (mirrors pi's PI_CACHE_RETENTION) ────────────────
 *
 *   short  → { type: 'ephemeral' }              — Anthropic 5-min default.
 *                                                 1× cache write cost.
 *   long   → { type: 'ephemeral', ttl: '1h' }    — survives the 5-min refresh
 *                                                 window. 2× write cost but
 *                                                 wins outright on any session
 *                                                 >5 min that reuses the same
 *                                                 prefix (system + tools +
 *                                                 early conversation history).
 *                                                 Requires Anthropic beta
 *                                                 header `extended-cache-ttl-
 *                                                 2025-04-11` — the provider
 *                                                 attaches it when retention
 *                                                 is 'long'.
 *   none   → no cache_control field at all.       — Useful for cost-instrumented
 *                                                 runs where you want to see
 *                                                 the un-cached price tag.
 *                                                 Also disables prompt_cache_key.
 *
 * ── OpenRouter routing detection ───────────────────────────────────────────
 *
 * When baseUrl is openrouter.ai AND model starts with "anthropic/", we inject
 * Anthropic-style cache_control breakpoints into the OpenAI message shape
 * (system block, last tool, last user/assistant text part). OpenRouter
 * forwards them upstream and Anthropic prompt caching engages exactly as if
 * we'd called Anthropic directly.
 *
 * Gemini (`google/*`) is NOT detected here. Vertex implicit caching is
 * server-driven and ignores cache_control markers; sending them is wasted
 * bytes. Pi makes the same call (openai-completions.ts:1042). If you need
 * affinity for Gemini hits, use prompt_cache_key — the openai-compat
 * provider sets it on long-retention requests for any OpenRouter route.
 *
 * ── prompt_cache_key gating (mirrors pi exactly) ───────────────────────────
 *
 * pi's openai-completions.ts:479-484 emits prompt_cache_key when:
 *   (baseUrl == api.openai.com && retention != 'none')   — OpenAI direct,
 *                                                          short or long.
 * OR
 *   (retention == 'long' && supportsLongTtl == true)     — any endpoint that
 *                                                          claims long-TTL
 *                                                          support, on long.
 *
 * `supportsLongTtl` is a per-provider capability bit. We treat it as true
 * for: OpenRouter+anthropic/ (Anthropic upstream supports it), and OpenAI
 * direct. Treat it as false for everything else — DeepSeek/Moonshot/Groq/
 * Ollama don't claim long-TTL support and field-strict proxies sometimes
 * reject unknown keys, so under-emit by default.
 *
 * ── Reference ──────────────────────────────────────────────────────────────
 *
 * Pi source (do not modify, kept as fixture for benchmark reproducibility):
 *   bench/2026-04/fixtures/pi-mono/packages/ai/src/providers/anthropic.ts:121
 *   bench/2026-04/fixtures/pi-mono/packages/ai/src/providers/openai-completions.ts:592-693
 */

export type CacheRetention = 'short' | 'long' | 'none';

/**
 * On-the-wire shape. Anthropic's non-beta SDK type
 * (`@anthropic-ai/sdk/resources/messages.d.ts`) only types `{ type: 'ephemeral' }`,
 * but the wire format accepts `ttl: '1h'` when the `extended-cache-ttl-2025-04-11`
 * beta header is set. Providers cast through `as any` at the attachment site
 * and add the beta header when retention is 'long' — see anthropic.ts.
 */
export interface CacheControlMarker {
  type: 'ephemeral';
  ttl?: '1h';
}

/**
 * Resolve final retention: env override beats configured value beats default.
 * ARIES_CACHE_RETENTION is the canonical env var; PI_CACHE_RETENTION is the
 * muscle-memory fallback (pi users coming over).
 *
 * Invalid env values silently fall through to the configured value rather
 * than throwing — config layer should validate before reaching here, but a
 * stray env typo shouldn't crash the CLI.
 */
export function resolveCacheRetention(configured?: CacheRetention): CacheRetention {
  const envRaw = process.env.ARIES_CACHE_RETENTION ?? process.env.PI_CACHE_RETENTION;
  if (envRaw === 'short' || envRaw === 'long' || envRaw === 'none') {
    return envRaw;
  }
  return configured ?? 'short';
}

/**
 * Build the cache_control marker for the given retention.
 *
 * Returns null when retention is 'none' — callers must drop the cache_control
 * field entirely rather than emitting `{ type: 'ephemeral' }` with TTL=0
 * (undefined behavior on the wire).
 *
 * `supportsLongTtl` gates the 1h TTL extension. Pass `true` for Anthropic
 * native and OpenRouter+anthropic/. Pass `false` for endpoints we don't
 * trust to honor it; they still get a bare 5-min ephemeral marker on 'long'
 * (graceful degradation rather than refusing to mark at all).
 */
export function buildCacheMarker(
  retention: CacheRetention,
  supportsLongTtl: boolean,
): CacheControlMarker | null {
  if (retention === 'none') return null;
  if (retention === 'long' && supportsLongTtl) {
    return { type: 'ephemeral', ttl: '1h' };
  }
  return { type: 'ephemeral' };
}

/**
 * Detect whether OpenRouter routing requires Anthropic-style cache_control
 * injection. Returns 'anthropic' when baseUrl is openrouter.ai AND model
 * starts with "anthropic/". Returns null otherwise.
 *
 * Gemini explicitly NOT detected — Vertex implicit caching ignores markers.
 * This is the deliberate scope cut from the plan; do not add a 'gemini'
 * branch here without first confirming OpenRouter→Vertex actually honors
 * the markers (it does not at the time of this writing).
 */
export function detectOpenRouterCacheFormat(
  baseUrl: string,
  model: string,
): 'anthropic' | null {
  if (!baseUrl.includes('openrouter.ai')) return null;
  if (model.startsWith('anthropic/')) return 'anthropic';
  return null;
}

/**
 * Whether to emit `prompt_cache_key` in the request body. Mirrors pi's
 * gating exactly (openai-completions.ts:479-484).
 *
 * Returning true here is a positive instruction — the caller should also
 * set `prompt_cache_retention: '24h'` when retention is 'long' AND
 * supportsLongTtl is true.
 */
export function shouldEmitPromptCacheKey(
  baseUrl: string,
  retention: CacheRetention,
  supportsLongTtl: boolean,
): boolean {
  if (baseUrl.includes('api.openai.com') && retention !== 'none') return true;
  if (retention === 'long' && supportsLongTtl) return true;
  return false;
}

// ── OpenAI-shape injection helpers ──────────────────────────────────────────
//
// These mutate a pre-built OpenAI Chat Completions message array so that
// when proxied through OpenRouter to Anthropic upstream, prompt caching
// engages on the right boundaries. Mirrors pi's applyAnthropicCacheControl
// (openai-completions.ts:592-693) byte-for-byte.

/**
 * Permissive OAI-message shape — matches what openai-compatible.ts builds.
 * We don't import the provider's strict types here to keep cache.ts
 * provider-agnostic. The inner content-part type has an index signature
 * because we mutate `cache_control` onto each text part; the outer
 * message and tool types do NOT, so callers' stricter types remain
 * structurally assignable. cache_control on tools is attached via an
 * `as Record<string, unknown>` cast at the assignment site below.
 */
type OAIMessageLike = {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }> | null;
};

type OAIToolLike = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/**
 * Inject Anthropic-style cache_control breakpoints at three sites:
 *   1. system/developer prompt (first such message)
 *   2. last tool definition (top-level cache_control on the tool object)
 *   3. last user/assistant text content (last text block)
 *
 * No-op when marker is null. Mutates `messages` and `tools` in place.
 *
 * Why these three sites: Anthropic prompt caching uses up to 4 cache breakpoints
 * per request. Pi picks 3 of them for the most-stable prefix (system → tools →
 * early conversation), leaving one reserved. The last user/assistant message
 * gets its own breakpoint so the conversation-tail cache extends with each
 * turn — same pattern as our anthropic.ts already uses for native Anthropic.
 */
export function injectOpenAIShapeCacheBreakpoints(
  messages: OAIMessageLike[],
  tools: OAIToolLike[] | undefined,
  marker: CacheControlMarker | null,
): void {
  if (!marker) return;

  // Site 1 — first system/developer message gets cache_control on its last
  // text part. Pi uses .find() with role check; we walk linearly to avoid
  // inserting an iteration helper just for this.
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      addCacheControlToTextContent(msg, marker);
      break;
    }
  }

  // Site 2 — last tool definition. cache_control attaches at the TOP LEVEL
  // of the tool object, NOT inside .function — pi confirmed at L637.
  if (tools && tools.length > 0) {
    const lastTool = tools[tools.length - 1];
    if (lastTool) {
      (lastTool as Record<string, unknown>).cache_control = marker;
    }
  }

  // Site 3 — last user/assistant message. Walk backwards to find the most
  // recent conversational message (skipping tool-result messages, which
  // have role 'tool'). First successful injection wins.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (addCacheControlToTextContent(msg, marker)) break;
    }
  }
}

/**
 * Attach cache_control to the message's last text content. Returns true if
 * attachment succeeded, false if the message had no text-shaped content
 * (e.g. an assistant message that was only tool_calls). Pi: L657-693.
 *
 * String content is converted to array form to make room for the field;
 * array content gets cache_control appended to the last text part.
 */
function addCacheControlToTextContent(
  msg: OAIMessageLike,
  marker: CacheControlMarker,
): boolean {
  const content = msg.content;

  if (typeof content === 'string') {
    if (content.length === 0) return false;
    msg.content = [
      { type: 'text', text: content, cache_control: marker },
    ] as Array<{ type: string; text?: string; [k: string]: unknown }>;
    return true;
  }

  if (!Array.isArray(content)) return false;

  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    if (part?.type === 'text') {
      part.cache_control = marker;
      return true;
    }
  }
  return false;
}
