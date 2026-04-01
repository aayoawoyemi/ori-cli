import type { AriesConfig } from './types.js';

export const DEFAULT_CONFIG: AriesConfig = {
  agent: {
    name: 'Aries',
  },
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
    maxResultChars: 30_000,
    parallelReadTools: true,
    maxSubagents: 5,
  },
  permissions: {
    mode: 'auto',
    allowBash: true,
    allowWrite: true,
    allowNetwork: true,
  },
  mcp: {
    servers: {},
  },
};
