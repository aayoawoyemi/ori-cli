import type { AriesConfig } from './types.js';

export const DEFAULT_CONFIG: AriesConfig = {
  agent: {
    name: 'Ori',
  },
  timezone: 'America/Chicago',
  displayMode: 'normal',
  // No hardcoded model. Users configure slots in ~/.aries/config.yaml.
  // The router throws a readable error at first call if primary is unset.
  models: {} as AriesConfig['models'],
  vault: {
    // preflight flag removed 2026-04-21 — ambient preflight retrieval path
    // killed 2026-04-19; codemode pulls memory on-demand via vault.* in Repl.
    // postflight + reflectionThreshold removed 2026-04-29 — auto-vault-write
    // pathway eliminated. See src/memory/postflight.ts header for rationale.
  },
  projectBrain: {
    enabled: true,
    autoExtract: true,
    maxMemories: 200,
  },
  compact: {
    // Auto-compaction is structurally disabled at the loop layer since the
    // 2026-04-19 no-injection refactor (src/loop.ts: "Auto-compaction stays
    // disabled — never compact mid-task"). The config flag was left at
    // `true` as a leftover; Batch 1.8 aligns config with behavior so this
    // surface stops lying. Microcompact (tool-result pruning over ~100k
    // tokens) is the only pruning pass that still runs, and it's unconditional.
    auto: false,
    threshold: 0.8,
    classifyTiers: true,
  },
  tools: {
    maxResultChars: 10_000,
    parallelReadTools: true,
    maxSubagents: 5,
    dynamicTools: true,
  },
  webSearch: {},
  permissions: {
    mode: 'manual',
    allowBash: true,
    allowWrite: true,
    allowNetwork: true,
  },
  local: {
    baseUrl: 'http://localhost:8080',
    contextSize: 32_768,
    gpuLayers: 20,
    models: {
      // Add downloaded GGUF paths here, e.g.:
      // 'devstral': { path: 'C:\\models\\devstralQ4_K_M.gguf', contextWindow: 131_072 },
      // 'qwen-coder-7b': { path: 'C:\\models\\Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', contextWindow: 32_768 },
      // 'qwen-coder-3b': { path: 'C:\\models\\Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf', contextWindow: 32_768 },
    },
  },
  hooks: {},
  repl: {
    enabled: 'auto',
    // Bumped 30s → 90s on 2026-04-21 (v0.5 Phase 1.5). The walk-codemode-region
    // manual trace on both Sonnet and Opus hit a 26.7s bridge timeout on the
    // first vault.explore call, then the model fragmented into 8+ recovery
    // probes trying to figure out what was available. vault.explore can take
    // 30-60s server-side on a cold spreading-activation walk; the prior 30s
    // budget guaranteed the timeout. 90s gives a real worst-case headroom
    // without inviting the model to write infinite-runtime scripts (per-call
    // hard cap stays in place). Server-side trim (Phase 2) will further
    // reduce the latency floor; this bump is the unconditional safety margin.
    timeoutMs: 90_000,
    maxIterations: 1000,
    maxRlmCalls: 10,
    sandbox: 'same_process',
    maxRestarts: 3,
  },
  signature: {
    codebase: { level: 'standard', maxTokens: 600 },
    vault: { level: 'standard', maxTokens: 600 },
    cachePrefix: true,
    includeInSubagents: false,
    // trimVaultReturns added 2026-04-21 (v0.5 Phase 1). Default true —
    // strips decoration (signals/spaces/rrf/warmth.internals/federation
    // markers) from MCP retrieval responses. Flip to false if you need
    // the full unmodified payload for debugging. Becomes redundant when
    // Ori MCP v0.6.0 ships source-side trim.
    trimVaultReturns: true,
  },
  // top-level preflight config removed 2026-04-21 — see vault.postflight note.
  experimental: {
    localClaudeSubscription: false,
    localChatGPTSubscription: false,
  },
  // Features — per-batch rollout flags for the 2026-04 build plan.
  // All default `false` during rollout; each flag flips to `true` only
  // after its batch's ship thresholds pass (manual ack at checkpoints).
  // Once a flag has held `true` across N sessions without regression,
  // graduate the behavior to unconditional and delete the flag.
  features: {
    // Batch 3 — flipped 2026-04-25. Walk-codemode test bisected: the
    // 121s bridge-request timeouts reproduce with flag OFF too, so
    // they're a pre-existing bridge-layer flake (Batch 1.6's standalone
    // repro was 0/100 but bridge-callback variants still hang
    // sometimes), NOT a Batch 3 regression. Walk still completes — the
    // model retries through the timeouts and lands on the correct
    // answer. Bridge stability is captured as a separate task; lifting
    // the output cap doesn't depend on it.
    harnessCleanup: true,
    contracts: false,
    craft: false,
    gotchas: false,
    transactions: false,
  },
  mcp: {
    servers: {},
  },
};


