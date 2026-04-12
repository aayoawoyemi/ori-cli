export interface ExperimentalConfig {
  /**
   * Local-only experimental path that uses Claude subscription credentials
   * already present on this machine instead of ANTHROPIC_API_KEY.
   */
  localClaudeSubscription: boolean;
  /**
   * Local-only experimental path that uses ChatGPT/Codex subscription credentials
   * from ~/.codex/auth.json instead of OPENAI_API_KEY.
   */
  localChatGPTSubscription: boolean;
}
export interface ModelConfig {
  provider: 'anthropic' | 'google' | 'openai' | 'openai-compatible' | 'moonshot' | 'deepseek' | 'groq' | 'fireworks' | 'openrouter' | 'ollama' | 'custom';
  model: string;
  auth?: 'api_key' | 'oauth';  // default: api_key. oauth uses the local Claude subscription path when explicitly enabled.
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
  threshold: number; // fraction of context window (0.0â€“1.0)
  classifyTiers: boolean;
}

export interface ToolsConfig {
  maxResultChars: number;
  parallelReadTools: boolean;
  maxSubagents: number;
  /**
   * Enable dynamic tool exposure — only expose tools relevant to the current
   * task phase (lean: Repl/Edit/Write/Bash/VaultAdd/ProjectSave). Widens to
   * full if model requests a tool outside the lean set. Saves ~3-5K tokens/turn.
   */
  dynamicTools: boolean;
}

export type WebSearchProvider = 'brave' | 'tavily' | 'serper' | 'serpapi';

export interface WebSearchConfig {
  /**
   * Which search API to use. Env vars for each provider also work and take
   * precedence over this config (BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, etc.).
   */
  provider?: WebSearchProvider;
  apiKey?: string;
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

export interface HookConfig {
  command: string;
  tools?: string[];
  timeout?: number;
}

export interface HooksConfig {
  sessionStart?: HookConfig[];
  preToolUse?: HookConfig[];
  postToolUse?: HookConfig[];
  stop?: HookConfig[];
  preCodeExecution?: HookConfig[];
  postCodeExecution?: HookConfig[];
}

export type SignatureLevel = 'lean' | 'standard' | 'deep' | 'max';

export interface SignatureLayerConfig {
  /** Content density â€” controls what gets included. */
  level: SignatureLevel;
  /** Hard ceiling on token budget. Progressive trimming below this cap. */
  maxTokens: number;
}

export interface SignatureConfig {
  codebase: SignatureLayerConfig;
  vault: SignatureLayerConfig;
  /** Insert Anthropic cache_control marker after signatures (Anthropic-only). */
  cachePrefix: boolean;
  /** Whether subagents inherit ambient signatures (default: false). */
  includeInSubagents: boolean;
}

export interface PreflightConfig {
  /**
   * Gate for preflight retrieval injection.
   * - true: always inject preflight results before model call
   * - false: never inject
   * - 'auto': inject only when repl.enabled is false (REPL mode lets the model
   *   pull memory on-demand via vault.query_*, so ambient injection becomes
   *   redundant overhead)
   */
  enabled: boolean | 'auto';
}

export interface ReplConfig {
  /** Whether to spawn the Python body subprocess at session start. */
  enabled: boolean;
  /** Default timeout per exec call, in ms. */
  timeoutMs: number;
  /** Max loop iterations before kill (Phase 2+, currently advisory). */
  maxIterations: number;
  /** Max rlm_call invocations per top-level exec (Phase 4+). */
  maxRlmCalls: number;
  /** Sandbox strategy. Phase 1 supports only same_process. */
  sandbox: 'same_process' | 'docker' | 'firecracker';
  /** Path to python executable. Auto-detected if omitted. */
  pythonCmd?: string;
  /** Path to body/server.py. Defaults to <repo>/body/server.py. */
  serverPath?: string;
  /** Max automatic restarts before giving up. */
  maxRestarts: number;
}

export interface LocalConfig {
  // llama.cpp server base URL. Default: http://localhost:8080
  baseUrl: string;
  // Path to llama-server binary (if not on PATH)
  binary?: string;
  // Default context size passed to llama-server via -c
  contextSize: number;
  // Default GPU layers passed to llama-server via --n-gpu-layers
  gpuLayers: number;
  // Map of shortname â†’ GGUF file path on disk
  models: Record<string, { path: string; contextWindow?: number }>;
}

export type DisplayMode = 'verbose' | 'normal' | 'quiet' | 'cerebral';

export interface AriesConfig {
  agent: AgentConfig;
  timezone: string;
  displayMode: DisplayMode;
  models: RouterConfig;
  local: LocalConfig;
  vault: VaultConfig;
  projectBrain: ProjectBrainConfig;
  compact: CompactConfig;
  tools: ToolsConfig;
  webSearch: WebSearchConfig;
  permissions: PermissionsConfig;
  hooks: HooksConfig;
  repl: ReplConfig;
  signature: SignatureConfig;
  preflight: PreflightConfig;
  experimental: ExperimentalConfig;
  mcp: { servers: Record<string, { command: string; args?: string[] }> };
}


