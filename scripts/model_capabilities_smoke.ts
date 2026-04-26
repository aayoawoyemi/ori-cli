/**
 * Batch 3 smoke for src/router/model-capabilities.ts. Pure-function tests
 * — no API calls. Validates the substring lookup behaves as advertised
 * (correct match, longest-needle wins where it matters, fallback engages
 * on unknown), and that resolveMaxTokens clamps overrides to upperLimit.
 *
 * Why this and not just leaning on tsc: the lookup table values are
 * load-bearing for token economics. A typo in the table OR a regression
 * in the resolution logic silently caps composed batches. tsc catches
 * type drift; this catches value drift. Run via `npx tsx`.
 */
import {
  getModelCapability,
  resolveMaxTokens,
  resolveThinkingBudget,
} from '../src/router/model-capabilities.js';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  OK   ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// ── Capability lookup ────────────────────────────────────────────────────

const opus47 = getModelCapability('claude-opus-4-7-20251201');
check(
  'opus-4-7 substring match (with date suffix) — default 128K',
  opus47.default === 128_000,
  `got default=${opus47.default}`,
);
check(
  'opus-4-7 upperLimit 128K',
  opus47.upperLimit === 128_000,
  `got upperLimit=${opus47.upperLimit}`,
);

const opus46 = getModelCapability('claude-opus-4-6');
check('opus-4-6 default = 128K (codemode maximalist)', opus46.default === 128_000);

const sonnet46 = getModelCapability('claude-sonnet-4-6');
check('sonnet-4-6 default = 64K, upperLimit = 128K',
  sonnet46.default === 64_000 && sonnet46.upperLimit === 128_000);

const haiku45 = getModelCapability('claude-haiku-4-5-20251001');
check('haiku-4-5 default = upperLimit = 64K',
  haiku45.default === 64_000 && haiku45.upperLimit === 64_000);

const opus41 = getModelCapability('claude-opus-4-1');
check('opus-4-1 default = upperLimit = 32K (older API ceiling)',
  opus41.default === 32_000 && opus41.upperLimit === 32_000);

// Fallback for unknown / future model IDs — must NOT match an existing entry.
const unknown = getModelCapability('claude-future-model-9-9');
check('unknown model falls back to conservative 16K default',
  unknown.default === 16_384,
  `got default=${unknown.default}`);
check('unknown model upperLimit = 32K',
  unknown.upperLimit === 32_000);

// Non-Claude IDs (e.g., openai-shaped) also fall back cleanly.
const nonClaude = getModelCapability('gpt-5-turbo');
check('non-Claude model id falls back to FALLBACK',
  nonClaude.default === 16_384 && nonClaude.upperLimit === 32_000);

// ── resolveMaxTokens ────────────────────────────────────────────────────

check('resolve default for opus-4-7 = 128K when no override',
  resolveMaxTokens('claude-opus-4-7') === 128_000);

check('resolve clamps explicit override above upperLimit',
  resolveMaxTokens('claude-opus-4-6', 200_000) === 128_000,
  `got ${resolveMaxTokens('claude-opus-4-6', 200_000)}`);

check('resolve honors explicit override below upperLimit',
  resolveMaxTokens('claude-opus-4-6', 50_000) === 50_000);

check('resolve clamps override on unknown model to FALLBACK upperLimit',
  resolveMaxTokens('claude-future-model-9-9', 100_000) === 32_000,
  `got ${resolveMaxTokens('claude-future-model-9-9', 100_000)}`);

check('resolve treats override=0 as no override (uses default)',
  resolveMaxTokens('claude-opus-4-7', 0) === 128_000);

check('resolve treats override=undefined as no override',
  resolveMaxTokens('claude-opus-4-7', undefined) === 128_000);

// Negative override — defensive: treat as no-override rather than allowing
// negative max_tokens through (would 400 the API).
check('resolve treats negative override as no override',
  resolveMaxTokens('claude-opus-4-7', -1) === 128_000);

// â”€â”€ resolveThinkingBudget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

check('thinking budget unchanged when safely below max_tokens',
  resolveThinkingBudget(128_000, 10_000) === 10_000);

check('thinking budget clamps to max_tokens - 1',
  resolveThinkingBudget(1_500, 10_000) === 1_499,
  `got ${resolveThinkingBudget(1_500, 10_000)}`);

check('thinking disabled when max_tokens cannot fit Anthropic minimum budget',
  resolveThinkingBudget(1_024, 10_000) === 0,
  `got ${resolveThinkingBudget(1_024, 10_000)}`);

check('thinking disabled for forced tiny cutoff caps',
  resolveThinkingBudget(100, 1_500) === 0,
  `got ${resolveThinkingBudget(100, 1_500)}`);

check('thinking disabled when requested budget is zero',
  resolveThinkingBudget(128_000, 0) === 0);

console.log(`\n${passed}/${passed + failed} model-capability checks passed`);
process.exit(failed === 0 ? 0 : 1);
