export interface ModelConfig {
  provider: 'anthropic' | 'google' | 'openai' | 'moonshot' | 'deepseek' | 'local' | 'custom';
  model: string;
  auth?: 'api_key' | 'oauth';  // default: api_key. oauth uses Claude subscription via cch signing.
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  contextWindow?: number;
}

export interface RouterConfig {
  primary: ModelConfig;
  reasoning?: ModelConfig;
  cheap?: ModelConfig;
  bulk?: ModelConfig;
}

export interface VaultConfig {
  path?: string;
  preflight: boolean;
  postflight: boolean;
  reflectionThreshold: number;
}

export interface ProjectBrainConfig {
  enabled: boolean;
  autoExtract: boolean;
  maxMemories: number;
}

export interface CompactConfig {
  auto: boolean;
  threshold: number; // fraction of context window (0.0–1.0)
  classifyTiers: boolean;
}

export interface ToolsConfig {
  maxResultChars: number;
  parallelReadTools: boolean;
  maxSubagents: number;
}

export interface PermissionsConfig {
  mode: 'auto' | 'ask' | 'manual';
  allowBash: boolean;
  allowWrite: boolean;
  allowNetwork: boolean;
}

export interface AgentConfig {
  name: string;
}

export interface AriesConfig {
  agent: AgentConfig;
  models: RouterConfig;
  vault: VaultConfig;
  projectBrain: ProjectBrainConfig;
  compact: CompactConfig;
  tools: ToolsConfig;
  permissions: PermissionsConfig;
  mcp: { servers: Record<string, { command: string; args?: string[] }> };
}
