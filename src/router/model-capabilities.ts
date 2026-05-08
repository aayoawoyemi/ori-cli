/**
 * Per-model capability table — output token defaults + ceilings, plus other
 * per-model values that future batches will hang off of (thinking budgets,
 * context windows, cost-per-token telemetry).
 *
 * Pattern lifted from Claude Code's production source (utils/context.ts:149-210):
 * substring match on canonical model name; explicit caller override gets
 * clamped to upperLimit; default is sent if no override. CC keeps `default`
 * conservative (often half of upperLimit). Aries deliberately diverges for
 * the codemode-target models (Opus 4.6/4.7) and sets default = upperLimit
 * because the codemode thesis is composed-batch maximalism — every Repl call
 * wants maximum composition headroom. Sonnet/Haiku stay at conservative
 * defaults to avoid surprising lighter-model behavior.
 *
 * Why static table over SDK runtime introspection (models.retrieve()):
 *   - Deterministic across sessions (same model always resolves the same)
 *   - Zero startup latency (no extra API round-trip)
 *   - Works offline / behind corporate proxies
 *   - Pi-mono converged on the same choice (packages/ai/src/models.generated.ts)
 *
 * When new Anthropic models ship, add an entry. The substring match means
 * minor-version churn (`-20251001` style suffixes) doesn't require updates.
 */

export type ModelCapability = {
  /** Baseline `max_tokens` sent to the API when caller doesn't override. */
  default: number;
  /** Ceiling for caller overrides; resolveMaxTokens clamps to this. */
  upperLimit: number;
  /** Reserved for future telemetry / context-budget logic. */
  contextWindow?: number;
  /** Whether the model supports any form of extended thinking (adaptive OR legacy budget). */
  supportsExtendedThinking?: boolean;
  /**
   * Whether the model supports adaptive thinking — `thinking: {type: 'adaptive'}`
   * with `output_config: {effort}`. When true, we send adaptive shape and let
   * the model self-regulate depth via effort. When false (or undefined), we
   * fall back to legacy `thinking: {type: 'enabled', budget_tokens: N}`.
   *
   * Per Anthropic docs (May 2026):
   *  - Opus 4.7 — adaptive ONLY (legacy enabled+budget rejected with 400)
   *  - Opus 4.6, Sonnet 4.6 — adaptive supported; legacy deprecated but still works
   *  - Older Sonnet/Haiku — legacy only, adaptive rejected
   *
   * Adaptive auto-enables interleaved thinking (model thinks BETWEEN tool calls).
   * On Opus 4.7 also requires `display: 'summarized'` to make thinking content
   * visible — defaults to 'omitted' which returns empty thinking blocks (the
   * "thinking feels like 2 lines max" symptom).
   */
  supportsAdaptiveThinking?: boolean;
};

export const MIN_THINKING_BUDGET_TOKENS = 1024;

// Substring-keyed; first match wins. Ordering: longest/most-specific first
// only matters if needles overlap (none currently — `opus-4-7` and `opus-4-6`
// are disjoint, not prefix-related).
const CAPABILITIES: Array<[string, ModelCapability]> = [
  // â”€â”€ Anthropic â”€â”€ Flagship composition models. Default = upperLimit (codemode maximalism).
  ['claude-opus-4-7',   { default: 128_000, upperLimit: 128_000, contextWindow: 200_000, supportsExtendedThinking: true, supportsAdaptiveThinking: true }],
  ['claude-opus-4-6',   { default: 128_000, upperLimit: 128_000, contextWindow: 200_000, supportsExtendedThinking: true, supportsAdaptiveThinking: true }],

  // Sonnet 4.6 â€” codemode-capable, default lifted but kept under upper.
  ['claude-sonnet-4-6', { default: 64_000,  upperLimit: 128_000, contextWindow: 200_000, supportsExtendedThinking: true, supportsAdaptiveThinking: true }],

  // Older Sonnets â€” lower API ceilings. No adaptive.
  ['claude-sonnet-4-5', { default: 64_000,  upperLimit: 64_000,  contextWindow: 200_000 }],
  ['claude-sonnet-4',   { default: 32_000,  upperLimit: 64_000,  contextWindow: 200_000 }],

  // Haiku 4.5 — cheap slot, run hot. Adaptive NOT supported per Anthropic docs.
  ['claude-haiku-4-5',  { default: 64_000,  upperLimit: 64_000,  contextWindow: 200_000 }],

  // Older Opus generations â€” capped tighter by the API itself.
  ['claude-opus-4-1',   { default: 32_000,  upperLimit: 32_000,  contextWindow: 200_000 }],
  ['claude-opus-4',     { default: 32_000,  upperLimit: 32_000,  contextWindow: 200_000 }],

  // â”€â”€ Open models â€” 128K output for top-tier, 64K for the rest â”€â”€

  // GLM 5.1 â€” Zhipu coding-focused, 202K context, 65K max output.
  ['glm-5.1',           { default: 128_000, upperLimit: 128_000, contextWindow: 202_752 }],

  // Kimi K2.6 â€” Moonshot agent-optimized, 262K context, multimodal.
  ['kimi-k2.6',         { default: 128_000, upperLimit: 128_000, contextWindow: 262_144 }],

  // DeepSeek V3/R1 â€” strong reasoning, 128K context.
  // DeepSeek V4 — 1M context window; set default/upper to 200K to avoid runaway costs.
  ['deepseek-v4-flash', { default: 200_000, upperLimit: 500_000, contextWindow: 1_000_000 }],
  ['deepseek-v4-pro',   { default: 200_000, upperLimit: 500_000, contextWindow: 1_000_000 }],
  // Legacy aliases mapped to v4-flash in the router.
  ['deepseek-chat',     { default: 200_000, upperLimit: 500_000, contextWindow: 1_000_000 }],
  ['deepseek-reasoner', { default: 200_000, upperLimit: 500_000, contextWindow: 1_000_000 }],

  // Qwen â€” DashScope, 131K context.
  ['qwen3.6-plus',      { default: 64_000,  upperLimit: 64_000,  contextWindow: 131_072 }],
  ['qwen3-235b',        { default: 64_000,  upperLimit: 64_000,  contextWindow: 131_072 }],

  // Gemini â€” Google, 1M context.
  ['gemini-2.5-pro',    { default: 64_000,  upperLimit: 64_000,  contextWindow: 1_000_000 }],
  ['gemini-2.5-flash',  { default: 64_000,  upperLimit: 64_000,  contextWindow: 1_000_000 }],

  // GPT â€” OpenAI, up to 1M context.
  ['gpt-5',             { default: 64_000,  upperLimit: 64_000,  contextWindow: 1_000_000 }],
  ['gpt-4o',            { default: 64_000,  upperLimit: 64_000,  contextWindow: 128_000 }],

  // MiniMax M2.7 â€” 1M context.
  ['minimax-m2.7',      { default: 64_000,  upperLimit: 64_000,  contextWindow: 1_000_000 }],
];

/**
 * Conservative fallback for unknown / future / non-Claude model IDs. 16K
 * matches the pre-Batch-3 hard default and won't break any model older than
 * Claude 3.5 (which capped at 8K but the API silently allows up to 4K so 16K
 * here would error politely). Bumping the fallback above 32K risks API
 * errors on models with smaller server-side ceilings.
 */
const FALLBACK: ModelCapability = {
  default: 16_384,
  upperLimit: 32_000,
};

export function getModelCapability(modelId: string): ModelCapability {
  for (const [needle, cap] of CAPABILITIES) {
    if (modelId.includes(needle)) return cap;
  }
  return FALLBACK;
}

/**
 * Resolve the `max_tokens` value to send to the Anthropic API for a given
 * model. Explicit `override` (from caller config) is clamped to the model's
 * `upperLimit` so a config typo like `maxTokens: 200_000` doesn't 400 the API.
 * Without an override, the model's `default` is used.
 *
 * Used in `AnthropicProvider` constructor when `features.harnessCleanup` is
 * true. Pre-flag behavior (raw scalar + 16K floor) is preserved when the
 * flag is off — see anthropic.ts:145.
 */
export function resolveMaxTokens(modelId: string, override?: number): number {
  const cap = getModelCapability(modelId);
  if (override !== undefined && override > 0) {
    return Math.min(override, cap.upperLimit);
  }
  return cap.default;
}

/**
 * Resolve an Anthropic extended-thinking budget against the final max_tokens
 * value that will be sent on the request. Anthropic requires:
 *   - max_tokens > thinking.budget_tokens
 *   - thinking.budget_tokens >= 1024 when thinking is enabled
 *
 * If max_tokens is intentionally tiny (forced-cutoff tests, cheap calls),
 * disable thinking for that request instead of raising max_tokens or sending
 * an invalid request shape.
 */
export function resolveThinkingBudget(maxTokens: number, requestedBudget: number): number {
  if (requestedBudget <= 0) return 0;

  const upper = maxTokens - 1;
  if (upper < MIN_THINKING_BUDGET_TOKENS) return 0;

  return Math.min(requestedBudget, upper);
}

/**
 * Whether this model accepts the adaptive thinking shape
 * (`thinking: {type: 'adaptive', display: 'summarized'}` + `output_config: {effort}`).
 *
 * Drives a fork in AnthropicProvider.stream(): adaptive-capable models get
 * the new shape (which auto-enables interleaved thinking and lets the model
 * self-regulate); everything else gets legacy `enabled+budget_tokens`.
 *
 * On Opus 4.7 specifically, legacy mode is REJECTED with a 400 — adaptive is
 * the only accepted shape.
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  return getModelCapability(modelId).supportsAdaptiveThinking === true;
}
