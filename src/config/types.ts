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

// Features — per-batch rollout flags. Each flag gates a coherent behavior
// change from the 2026-04 build plan (schema-enforced Repl + Ori v0.6.0).
// Default `false` during rollout; a flag flips to `true` only after its
// batch's ship thresholds pass (see plan verification gates). One-line
// revert if a field issue appears. Promoted to the config root (not
// nested under experimental) so the flags stay visible and ephemeral —
// they graduate to unconditional behavior once the batch's verification
// has held for N sessions, then the flag is deleted.
export interface FeaturesConfig {
  /** Stream A.7 — per-model maxTokens, stream force-flush, cutoff_warning,
   *  prompt cut, registry factory collapse. */
  harnessCleanup: boolean;
  /** Stream A.8 first half — shape-stable returns, structured errors,
   *  continuation affordances. */
  contracts: boolean;
  /** Stream A.8 second half — chainability (fmt.*), _many batch variants,
   *  input-repair shims, per-tool promptGuidelines, provider-never-throws. */
  craft: boolean;
  /** Stream A.9 layer 4 — gotcha capture + per-turn injection. Orthogonal
   *  to `transactions` — they're separate risk classes. */
  gotchas: boolean;
  /** Stream A.9 layer 5 — transactional rollback on destructive batches. */
  transactions: boolean;
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
  // All slots are optional at the type level so first-run users don't crash.
  // The router throws a readable error at the first call site when primary is unset.
  primary?: ModelConfig;
  reasoning?: ModelConfig;
  cheap?: ModelConfig;
  bulk?: ModelConfig;
}

export interface VaultConfig {
  path?: string;
  // VaultConfig.preflight flag removed 2026-04-21 — the ambient preflight
  // retrieval path was killed 2026-04-19 (codemode harness pulls memory
  // on-demand via vault.* in the Repl). Flag had no consumers.
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
  /**
   * Bridge-side tactical trim of vault MCP return payloads — strips
   * `signals`, `spaces`, `rrf`/`rrf_base`/`composite`, warmth internals,
   * and federation markers (`_federated`, `_vault`, `_sources`) before
   * the response reaches the Python proxy. Added 2026-04-21 as Phase 1
   * of v0.5; becomes redundant once Ori MCP ships server-side trim in
   * v0.6.0 (Phase 2). Default `true`. Set `false` to get the raw
   * unmodified MCP payload — useful if you're debugging rank decisions
   * or need to inspect signal breakdowns.
   */
  trimVaultReturns: boolean;
}

// PreflightConfig removed 2026-04-21 — see VaultConfig note above.

export interface ReplConfig {
  /** Whether to spawn the Python body subprocess at session start. 'auto' = enable only for REPL-capable models. */
  enabled: boolean | 'auto';
  /** Default timeout per exec call, in ms. */
  timeoutMs: number;
  /** Max loop iterations before kill (Phase 2+, currently advisory). */
  maxIterations: number;
  /** Max rlm_call invocations per top-level exec (Phase 4+). */
  maxRlmCalls: number;
  /** Model for rlm_call. Overrides the env-based default.
   * Env-based defaults (picked in src/index.ts resolveRlmConfig):
   *   - If OPENROUTER_API_KEY set → 'openai/gpt-oss-20b'
   *   - Else if ANTHROPIC_API_KEY set → 'claude-haiku-4-5-20251001' via Anthropic's OpenAI-compat endpoint
   *   - Else → 'unset' (rlm disabled) */
  rlmModel?: string;
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
  experimental: ExperimentalConfig;
  features: FeaturesConfig;
  mcp: { servers: Record<string, { command: string; args?: string[] }> };
}


