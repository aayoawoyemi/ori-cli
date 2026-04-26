/**
 * No-network smoke for Anthropic request params.
 *
 * Captures the request object passed to the SDK stream call so Batch 3 cannot
 * regress into invalid Anthropic shapes:
 *   - Claude shortcuts must use per-model max_tokens defaults, not effort caps.
 *   - thinking.budget_tokens must be omitted or clamped so max_tokens > budget.
 */
import { AnthropicProvider } from '../src/router/providers/anthropic.js';
import { ModelRouter } from '../src/router/index.js';
import type { FeaturesConfig, ModelConfig, RouterConfig } from '../src/config/types.js';

const features: FeaturesConfig = {
  harnessCleanup: true,
  contracts: false,
  craft: false,
  gotchas: false,
  transactions: false,
};

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

async function captureAnthropicParams(
  config: ModelConfig,
  thinkingBudget: number,
): Promise<Record<string, unknown>> {
  const provider = new AnthropicProvider(config, { features });
  provider.setThinkingBudget(thinkingBudget);

  let captured: Record<string, unknown> | null = null;
  (provider as unknown as {
    client: {
      messages: {
        stream: (params: Record<string, unknown>) => AsyncIterable<unknown>;
      };
    };
  }).client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        captured = params;
        throw new Error('__capture__');
      },
    },
  };

  try {
    for await (const _ of provider.stream([{ role: 'user', content: 'hello' }], 'system', [])) {
      // unreachable
    }
  } catch {
    // Expected: fake SDK throws after capturing params.
  }

  if (!captured) throw new Error('failed to capture Anthropic params');
  return captured;
}

function routerForShortcuts(): ModelRouter {
  const config: RouterConfig = {
    primary: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: '',
    },
  };
  return new ModelRouter(config, undefined, features);
}

for (const [shortcut, expectedMax] of [
  ['opus high', 128_000],
  ['sonnet high', 64_000],
  ['haiku high', 64_000],
] as const) {
  const router = routerForShortcuts();
  router.setModel(shortcut);
  const provider = router.current as unknown as { getMaxTokens?: () => number };
  check(
    `${shortcut} shortcut uses Batch 3 capability max_tokens`,
    provider.getMaxTokens?.() === expectedMax,
    `got ${provider.getMaxTokens?.()}`,
  );
}

const tiny = await captureAnthropicParams({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  apiKey: '',
  maxTokens: 100,
}, 1_500);
check(
  'forced tiny maxTokens omits thinking instead of 400ing',
  !('thinking' in tiny),
  `thinking=${JSON.stringify(tiny.thinking)}`,
);

const clamped = await captureAnthropicParams({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  apiKey: '',
  maxTokens: 1_500,
}, 10_000);
check(
  'thinking clamps below max_tokens',
  JSON.stringify(clamped.thinking) === JSON.stringify({ type: 'enabled', budget_tokens: 1_499 }),
  `thinking=${JSON.stringify(clamped.thinking)}`,
);

const normal = await captureAnthropicParams({
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  apiKey: '',
}, 10_000);
check(
  'normal Opus request keeps 128K max_tokens and 10K thinking',
  normal.max_tokens === 128_000 &&
    JSON.stringify(normal.thinking) === JSON.stringify({ type: 'enabled', budget_tokens: 10_000 }),
  `max_tokens=${normal.max_tokens} thinking=${JSON.stringify(normal.thinking)}`,
);

console.log(`\n${passed}/${passed + failed} Anthropic request-shape checks passed`);
process.exit(failed === 0 ? 0 : 1);
