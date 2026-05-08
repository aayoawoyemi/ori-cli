/**
 * Thinking-format compat table for OpenAI-compatible providers.
 *
 * Background. Different reasoning models use different conventions for
 * turning thinking on, surfacing reasoning content, and preserving it
 * across turns. The OpenAI /v1/chat/completions endpoint became a
 * lowest-common-denominator surface, but each upstream layered its own
 * thinking dialect on top:
 *
 *   - GLM 5+ (Zhipu / z.ai / OpenRouter+z-ai/*):
 *       Write:   body.thinking = { type: "enabled" }
 *                body.clear_thinking = false   (preserved thinking — critical)
 *       Read:    delta.reasoning_content
 *       Preserve: yes — assistant messages must echo reasoning_content back,
 *                 or model loses logical thread AND prefix-cache hits.
 *
 *   - Kimi K2.6 (Moonshot / OpenRouter+moonshotai/*):
 *       Write:   nothing (auto-on)
 *       Read:    delta.reasoning_content
 *       Preserve: no
 *
 *   - DeepSeek R1 (api.deepseek.com / OpenRouter+deepseek/r*):
 *       Write:   nothing (always on)
 *       Read:    delta.reasoning_content
 *       Preserve: no — DeepSeek's server-side disk cache reconstructs
 *                 reasoning from prefix matches.
 *
 *   - Qwen 3 (DashScope / OpenRouter+qwen/qwen3*):
 *       Write:   body.enable_thinking = true
 *       Read:    delta.reasoning_content
 *       Preserve: no
 *
 *   - GPT-5 / o3 / o4-mini (api.openai.com):
 *       Write:   body.reasoning_effort = "high"
 *       Read:    nothing visible (server-internal)
 *       Preserve: no
 *
 *   - Gemini (via OpenRouter): implicit auto, no client controls.
 *   - DeepSeek V3, plain GPT-4o, and most other models: no thinking surface.
 *
 * Without this table, the openai-compatible provider:
 *   1. Never sends thinking params → models that REQUIRE explicit opt-in
 *      (GLM, Qwen) run with reasoning DISABLED.
 *   2. Doesn't read reasoning_content from the SSE delta → reasoning is
 *      streamed but silently dropped on the floor.
 *   3. Doesn't echo reasoning_content back in toOAIMessages → models that
 *      depend on prior-turn reasoning (GLM) lose their logical thread on
 *      every tool-call round.
 *
 * Each entry answers three questions per (provider/baseUrl, model) pair.
 *
 * Adding a new model is one entry: paste a row into the FORMATS array. The
 * provider integration is unchanged.
 */

import type { EffortLevel } from './types.js';

export type ThinkingFormat = {
  /**
   * Mutate the request body to enable reasoning. Called once per stream()
   * before the body is sent. Receives the current effort level so providers
   * that take a discrete level (`reasoning_effort`) can map it through.
   * Set to undefined when no body params are needed (model auto-thinks).
   */
  applyToBody?: (body: Record<string, unknown>, effort: EffortLevel) => void;

  /**
   * Field names on the SSE `delta` object that carry reasoning content.
   * Scanned in order; first non-empty wins. Yielded as `{type: 'thinking',
   * content}` events to the loop, which renders them as dim italic in the UI
   * (parity with Anthropic's thinking blocks).
   *
   * Empty array = no read-side handling needed (server-internal reasoning,
   * e.g. GPT-5 / o3 — Anthropic hides theirs server-side too unless you
   * explicitly opt in to summarized display).
   */
  readDeltaFields: string[];

  /**
   * Whether reasoning_content from prior assistant turns must be echoed
   * back in the message history to preserve cache hits and logical
   * continuity.
   *
   * GLM 5.x is the load-bearing case: their docs explicitly require
   * reasoning_content round-trip — "any reordering or modification of this
   * sequence will degrade the model's performance and negatively impact
   * cache efficiency." Without it, agentic loops re-derive reasoning from
   * scratch every tool-call round.
   *
   * DeepSeek and Qwen don't require this (DeepSeek has server-side prefix
   * cache; Qwen recomputes cheaply). Kimi works either way.
   */
  preserveInHistory: boolean;
};

/**
 * Format table. Order matters — first matching entry wins. Specific entries
 * (e.g. `qwen3-vl`) should come before broader ones (`qwen3`).
 *
 * Match logic: BOTH baseUrl regex AND model regex must match. A provider can
 * appear under multiple baseUrls (GLM is reachable via z-ai direct, Zhipu
 * direct, AND OpenRouter), so the baseUrl regex captures all of them.
 */
const FORMATS: Array<{ baseUrl: RegExp; model: RegExp; format: ThinkingFormat }> = [
  // ── GLM 5+ ─────────────────────────────────────────────────────────────
  // Zhipu's coding-focused reasoning model. Trained around interleaved +
  // preserved thinking; running it without these params is "brain disabled."
  // Reachable via: z-ai direct, Zhipu direct, OpenRouter (z-ai/*), bigmodel.cn.
  {
    baseUrl: /(openrouter|z-ai|zhipu|bigmodel)/i,
    model: /glm-5/i,
    format: {
      applyToBody: (body) => {
        body.thinking = { type: 'enabled' };
        // clear_thinking: false preserves reasoning state across the request
        // chain. Without this, the model resets its reasoning between every
        // turn, which destroys the whole point on agentic workloads.
        body.clear_thinking = false;
      },
      readDeltaFields: ['reasoning_content'],
      preserveInHistory: true,
    },
  },

  // ── Kimi K2.6 ──────────────────────────────────────────────────────────
  // Moonshot's agent-optimized model. Reasoning is auto-on, no enable param
  // needed. Just need to surface the reasoning_content in the UI.
  {
    baseUrl: /(openrouter|moonshot)/i,
    model: /kimi-k2/i,
    format: {
      readDeltaFields: ['reasoning_content'],
      preserveInHistory: false,
    },
  },

  // ── DeepSeek R1 ────────────────────────────────────────────────────────
  // Always-on reasoning model. Server-side disk cache handles round-trip
  // reasoning, so we don't need to echo it back.
  // Note: deepseek-chat (V3) is NOT a reasoning model; only matches r1/r2/etc.
  {
    baseUrl: /(deepseek|openrouter)/i,
    model: /deepseek-r/i,
    format: {
      readDeltaFields: ['reasoning_content'],
      preserveInHistory: false,
    },
  },

  // ── Qwen 3 ─────────────────────────────────────────────────────────────
  // DashScope's reasoning model. Requires explicit enable_thinking param;
  // without it runs in non-reasoning mode.
  {
    baseUrl: /(openrouter|dashscope|aliyuncs)/i,
    model: /qwen3/i,
    format: {
      applyToBody: (body) => {
        body.enable_thinking = true;
      },
      readDeltaFields: ['reasoning_content'],
      preserveInHistory: false,
    },
  },

  // ── OpenAI reasoning models (gpt-5, o3, o4-mini) ───────────────────────
  // Use reasoning_effort param. Reasoning content is server-internal —
  // OpenAI doesn't surface it client-side, so no read fields.
  {
    baseUrl: /api\.openai\.com/i,
    model: /^(gpt-5|o3|o4-mini|gpt-4\.1)/i,
    format: {
      applyToBody: (body, effort) => {
        // Map our 4-tier (max/high/medium/low) onto OpenAI's 3-tier
        // (high/medium/low). 'max' folds into 'high' since OpenAI doesn't
        // expose a higher-than-high tier.
        body.reasoning_effort = effort === 'max' ? 'high' : effort;
      },
      readDeltaFields: [],
      preserveInHistory: false,
    },
  },
];

/**
 * Resolve the thinking format for a given (baseUrl, model) pair. Returns a
 * default empty format (no body mutation, no read fields, no preservation)
 * when nothing matches — callers can use it unconditionally.
 */
export function resolveThinkingFormat(baseUrl: string, model: string): ThinkingFormat {
  for (const entry of FORMATS) {
    if (entry.baseUrl.test(baseUrl) && entry.model.test(model)) {
      return entry.format;
    }
  }
  return { readDeltaFields: [], preserveInHistory: false };
}
