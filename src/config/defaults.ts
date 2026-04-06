import type { AriesConfig } from './types.js';

export const DEFAULT_CONFIG: AriesConfig = {
  agent: {
    name: 'Aries',
  },
  timezone: 'America/Chicago',
  displayMode: 'normal',
  models: {
    primary: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      contextWindow: 200_000,
      maxTokens: 16_384,
    },
  },
  vault: {
    preflight: true,
    postflight: true,
    reflectionThreshold: 150,
  },
  projectBrain: {
    enabled: true,
    autoExtract: true,
    maxMemories: 200,
  },
  compact: {
    auto: true,
    threshold: 0.8,
    classifyTiers: true,
  },
  tools: {
    maxResultChars: 10_000,
    parallelReadTools: true,
    maxSubagents: 5,
  },
  permissions: {
    mode: 'auto',
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
    enabled: false,
    timeoutMs: 30_000,
    maxIterations: 1000,
    maxRlmCalls: 10,
    sandbox: 'same_process',
    maxRestarts: 3,
  },
  signature: {
    codebase: { level: 'standard', maxTokens: 1500 },
    vault: { level: 'standard', maxTokens: 1500 },
    cachePrefix: true,
    includeInSubagents: false,
  },
  preflight: {
    enabled: 'auto',  // auto-disables when repl.enabled (REPL pulls memory on-demand)
  },
  experimental: {
    localClaudeSubscription: false,
  },
  mcp: {
    servers: {},
  },
};


