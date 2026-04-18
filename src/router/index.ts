import type { ModelProvider, Message, ToolDefinition, StreamEvent, ModelSlot, ContentBlock, ImageContent } from './types.js';
import type { RouterConfig, ModelConfig, ExperimentalConfig } from '../config/types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { OpenAICompatibleProvider } from './providers/openai-compatible.js';

// â”€â”€ Effort Levels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type EffortLevel = 'high' | 'medium' | 'low';

const EFFORT_CONFIG: Record<EffortLevel, { maxTokens: number; thinkingBudget: number }> = {
  // thinkingBudget = 0 → no thinking (instant); >0 → extended thinking with that token budget
  high:   { maxTokens: 32_768, thinkingBudget: 10_000 },
  medium: { maxTokens: 16_384, thinkingBudget: 1_500 },
  low:    { maxTokens: 8_192,  thinkingBudget: 0 },
};

// â”€â”€ Model Shortnames â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Map friendly names to provider + model configs

// ── REPL-Capable Models ───────────────────────────────────────────────────────
// Models smart enough to use the Repl tool reliably (Python code-acting).
// Weaker models hallucinate Python syntax, call wrong methods, or get confused
// by the codebase API. Only models on this list get the Repl tool when
// repl.enabled is set to 'auto'.

const REPL_CAPABLE_MODELS = new Set([
  // Anthropic
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  // OpenAI
  'gpt-5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'o4-mini',
  // Google
  'gemini-2.5-pro', 'gemini-2.5-flash',
  // Qwen
  'qwen3.6-plus', 'qwen3-235b-a22b',
  // GLM
  'glm-5.1',
  // Kimi
  'kimi-k2',
]);

/** Check if a model ID is capable of using the Repl tool. */
export function isReplCapableModel(modelId: string): boolean {
  // Exact match first
  if (REPL_CAPABLE_MODELS.has(modelId)) return true;
  // Prefix match for versioned models (e.g. claude-sonnet-4-6-20250514)
  // and slash-aware match for provider-routed IDs (e.g. "z-ai/glm-5.1", "qwen/qwen3.6-plus")
  for (const capable of REPL_CAPABLE_MODELS) {
    if (modelId.startsWith(capable)) return true;
    if (modelId.includes('/' + capable)) return true;
  }
  return false;
}

// ── Vision-Capable Models ─────────────────────────────────────────────────────
// Models with native image input. Everything else routes through the vision
// proxy (describeImage) that converts image blocks to text before sending.

const VISION_MODEL_PREFIXES = [
  // Anthropic
  'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4',
  // OpenAI
  'gpt-4o', 'gpt-5', 'gpt-5.4', 'gpt-5.3', 'gpt-5.2', 'o4-mini', 'o3',
  // Google
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash', 'gemini-3-pro',
  // Qwen VL (vision variants only — base qwen3.6/qwen3 are text-only)
  'qwen-vl', 'qwen3-vl', 'qwen2.5-vl',
  // GLM vision (glm-4.5v / glm-5.1v — base glm-5.1 is text-only)
  'glm-4.5v', 'glm-5.1v',
  // Kimi vision
  'kimi-vl',
  // Llama vision
  'llama-3.2-vision', 'llama-4-vision',
];

/** Check if a model ID supports native image input. */
export function isVisionCapableModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  for (const prefix of VISION_MODEL_PREFIXES) {
    // startsWith for bare IDs ("gemini-2.5-flash")
    // "/" + prefix for provider-routed IDs ("google/gemini-3-flash-preview")
    if (lower.startsWith(prefix) || lower.includes('/' + prefix)) return true;
  }
  return false;
}

interface ModelShortcut {
  provider: ModelConfig['provider'];
  model: string;
  contextWindow: number;
  auth?: 'oauth' | 'api_key';
  baseUrl?: string;         // for local or custom-endpoint models
  apiKeyEnv?: string;       // override env var for API key resolution
  maxOutputTokens?: number; // hard cap (overrides effort-derived maxTokens)
}

const MODEL_SHORTCUTS: Record<string, ModelShortcut> = {
  // â”€â”€ Anthropic â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'opus':           { provider: 'anthropic', model: 'claude-opus-4-6',           contextWindow: 1_000_000 },
  'opus-200k':      { provider: 'anthropic', model: 'claude-opus-4-6',           contextWindow: 200_000   },
  'sonnet':         { provider: 'anthropic', model: 'claude-sonnet-4-6',         contextWindow: 200_000   },
  'haiku':          { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000   },

  // Claude subscription (local OAuth — requires experimental.localClaudeSubscription: true)
  // 1M beta context is available on Max plans for Opus and Sonnet via context-1m-2025-08-07.
  // Haiku 4.5 does not support the 1M beta — stays at 200K.
  'opus-sub':       { provider: 'anthropic', model: 'claude-opus-4-6',           contextWindow: 1_000_000, auth: 'oauth' },
  'sonnet-sub':     { provider: 'anthropic', model: 'claude-sonnet-4-6',         contextWindow: 1_000_000, auth: 'oauth' },
  'haiku-sub':      { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000,   auth: 'oauth' },

  // â”€â”€ Google â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'gemini':   { provider: 'google', model: 'gemini-2.5-pro', contextWindow: 1_000_000 },
  'flash':    { provider: 'google', model: 'gemini-2.5-flash', contextWindow: 1_000_000 },

  // ── OpenAI ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  'gpt4o':       { provider: 'openai', model: 'gpt-4o',       contextWindow: 128_000 },
  'gpt5':        { provider: 'openai', model: 'gpt-5',        contextWindow: 1_000_000 },
  'o4-mini':     { provider: 'openai', model: 'o4-mini',      contextWindow: 200_000 },
  // ChatGPT subscription models (require localChatGPTSubscription: true + ~/.codex/auth.json)
  'gpt-5.4':     { provider: 'openai', model: 'gpt-5.4',      contextWindow: 1_000_000, auth: 'oauth' },
  'gpt-5.4-mini':{ provider: 'openai', model: 'gpt-5.4-mini', contextWindow: 1_000_000, auth: 'oauth' },
  'gpt-5.3':     { provider: 'openai', model: 'gpt-5.3-codex',contextWindow: 1_000_000, auth: 'oauth' },
  'gpt-5.2':     { provider: 'openai', model: 'gpt-5.2',      contextWindow: 1_000_000, auth: 'oauth' },

  // â”€â”€ Moonshot / Kimi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'kimi':     { provider: 'moonshot', model: 'kimi-k2', contextWindow: 128_000 },
  'kimi-k2':  { provider: 'moonshot', model: 'kimi-k2', contextWindow: 128_000 },

  // â”€â”€ DeepSeek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'deepseek':    { provider: 'deepseek', model: 'deepseek-chat',     contextWindow: 128_000, maxOutputTokens: 8_192 },
  'deepseek-r1': { provider: 'deepseek', model: 'deepseek-reasoner', contextWindow: 128_000, maxOutputTokens: 8_192 },

  // â”€â”€ Groq (fast inference) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'llama':    { provider: 'groq', model: 'llama-3.3-70b-versatile', contextWindow: 128_000 },

  // â”€â”€ Alibaba DashScope International (ap-southeast-1) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'qwen3.6':       { provider: 'openai-compatible', model: 'qwen3.6-plus',          contextWindow: 131_072, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  'qwen3':         { provider: 'openai-compatible', model: 'qwen3-235b-a22b',       contextWindow: 131_072, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  'qwen-plus':     { provider: 'openai-compatible', model: 'qwen-plus',             contextWindow: 131_072, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },

  // â”€â”€ OpenRouter â€” access 200+ models via one API key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Free tier models (no cost, rate-limited)
  'qwen3.6-free':  { provider: 'openrouter', model: 'qwen/qwen3.6-plus:free',       contextWindow: 131_072 },
  'qwen3-free':    { provider: 'openrouter', model: 'qwen/qwen3-235b-a22b:free',    contextWindow: 131_072 },
  'gemma4-free':   { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free', contextWindow: 262_144 },

  // Paid OpenRouter models (much cheaper than direct APIs)
  'qwen3.6-or':    { provider: 'openrouter', model: 'qwen/qwen3.6-plus',            contextWindow: 131_072 },
  'minimax':       { provider: 'openrouter', model: 'minimax/minimax-m2.7',         contextWindow: 1_000_000 },
  'deepseek-v3':   { provider: 'openrouter', model: 'deepseek/deepseek-v3.2',       contextWindow: 131_072 },
  'gemini-flash':  { provider: 'openrouter', model: 'google/gemini-3-flash-preview', contextWindow: 1_000_000 },
  'glm5':          { provider: 'openrouter', model: 'z-ai/glm-5.1',                 contextWindow: 202_752 },
  'glm5.1':        { provider: 'openrouter', model: 'z-ai/glm-5.1',                 contextWindow: 202_752 },
  'gemma4':        { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it',    contextWindow: 262_144 },

  // â”€â”€ Local (llama.cpp via openai-compatible API on port 8080) â”€â”€â”€â”€â”€â”€
  // llama-server ignores the model field â€” it serves whatever GGUF is loaded.
  // Context windows match actual model capabilities at Q4_K_M quantization.
  // Start llama-server with: llama-server -m <path>.gguf -c 32768 --n-gpu-layers 20 --port 8080
  'local':         { provider: 'openai-compatible', model: 'local',         contextWindow: 32_768,  baseUrl: 'http://localhost:8080/v1' },
  'devstral':      { provider: 'openai-compatible', model: 'devstral',      contextWindow: 131_072, baseUrl: 'http://localhost:8080/v1' },
  'qwen-coder-7b': { provider: 'openai-compatible', model: 'qwen-coder-7b', contextWindow: 32_768,  baseUrl: 'http://localhost:8080/v1' },
  'qwen-coder-3b': { provider: 'openai-compatible', model: 'qwen-coder-3b', contextWindow: 32_768,  baseUrl: 'http://localhost:8080/v1' },
  'phi4-mini':     { provider: 'openai-compatible', model: 'phi4-mini',     contextWindow: 131_072, baseUrl: 'http://localhost:8080/v1' },
  'gemma3-4b':     { provider: 'openai-compatible', model: 'gemma3-4b',     contextWindow: 131_072, baseUrl: 'http://localhost:8080/v1' },

  // â”€â”€ Full model IDs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'claude-opus-4-6':    { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 1_000_000 },
  'claude-sonnet-4-6':  { provider: 'anthropic', model: 'claude-sonnet-4-6', contextWindow: 200_000 },
  'gemini-2.5-pro':     { provider: 'google', model: 'gemini-2.5-pro', contextWindow: 1_000_000 },
  'gemini-2.5-flash':   { provider: 'google', model: 'gemini-2.5-flash', contextWindow: 1_000_000 },
};

// â”€â”€ Provider â†’ env key mapping (for shortcut resolution) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PROVIDER_ENV_KEYS: Partial<Record<ModelConfig['provider'], string>> = {
  anthropic:          'ANTHROPIC_API_KEY',
  google:             'GOOGLE_API_KEY',
  openai:             'OPENAI_API_KEY',
  'openai-compatible':'OPENAI_API_KEY',
  deepseek:           'DEEPSEEK_API_KEY',
  moonshot:           'MOONSHOT_API_KEY',
  groq:               'GROQ_API_KEY',
  fireworks:          'FIREWORKS_API_KEY',
  openrouter:         'OPENROUTER_API_KEY',
};

// â”€â”€ Provider Factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createProvider(config: ModelConfig, experimental?: ExperimentalConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config, {
        allowExperimentalLocalOAuth: experimental?.localClaudeSubscription ?? false,
      });
    case 'google':
      return new GoogleProvider(config);
    case 'openai':
    case 'openai-compatible':
    case 'deepseek':
    case 'moonshot':
    case 'groq':
    case 'fireworks':
    case 'openrouter':
    case 'ollama':
    case 'custom':
      return new OpenAICompatibleProvider(config, {
        allowLocalOAuth: experimental?.localChatGPTSubscription ?? false,
      });
    default:
      throw new Error(`Unsupported provider: ${config.provider}. Available: anthropic, google, openai-compatible, deepseek, moonshot, groq, fireworks, openrouter, ollama`);
  }
}

// â”€â”€ Model Router â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export class ModelRouter {
  private providers = new Map<ModelSlot, ModelProvider>();
  private activeSlot: ModelSlot = 'primary';
  private overrideSlot: ModelSlot | null = null;
  private overrideProvider: ModelProvider | null = null;
  /** Shortcut name that produced the current override (e.g. "opus-sub"). null when no shortcut is active. */
  private overrideShortcut: string | null = null;
  private _effort: EffortLevel = 'medium';
  private primaryConfig: ModelConfig;
  private experimental?: ExperimentalConfig;

  constructor(config: RouterConfig, experimental?: ExperimentalConfig) {
    // Primary is optional at construction — a fresh install with no config
    // should be able to load the CLI and see an onboarding screen rather than
    // crash. The router throws a readable error at first call site below.
    this.primaryConfig = config.primary ?? ({} as ModelConfig);
    this.experimental = experimental;
    if (config.primary) this.providers.set('primary', createProvider(config.primary, this.experimental));
    if (config.reasoning) this.providers.set('reasoning', createProvider(config.reasoning, this.experimental));
    if (config.cheap) this.providers.set('cheap', createProvider(config.cheap, this.experimental));
    if (config.bulk) this.providers.set('bulk', createProvider(config.bulk, this.experimental));
  }

  /** Readable error when a caller tries to use an unset primary slot. */
  private requirePrimary(): ModelProvider {
    const p = this.providers.get('primary');
    if (!p) {
      throw new Error(
        'No primary model configured. Set one in ~/.aries/config.yaml:\n\n' +
        'models:\n' +
        '  primary:\n' +
        '    provider: openrouter\n' +
        '    model: z-ai/glm-5.1\n' +
        '    apiKey: ${OPENROUTER_API_KEY}\n\n' +
        'Or run `/model primary <shortcut>` to set one for this session only.',
      );
    }
    return p;
  }

  /** Current effort level. */
  get effort(): EffortLevel { return this._effort; }

  /** Set effort level. */
  setEffort(level: EffortLevel): void {
    this._effort = level;
  }

  /** Get the currently active provider. */
  get current(): ModelProvider {
    if (this.overrideProvider) return this.overrideProvider;
    const slot = this.overrideSlot ?? this.activeSlot;
    const p = this.providers.get(slot) ?? this.providers.get('primary');
    if (!p) return this.requirePrimary();
    return p;
  }

  /** Override with a slot name (primary/reasoning/cheap/bulk). */
  setSlotOverride(slot: ModelSlot): void {
    if (!this.providers.has(slot)) {
      throw new Error(`No provider configured for slot: ${slot}`);
    }
    this.overrideSlot = slot;
    this.overrideProvider = null;
    this.overrideShortcut = null;
  }

  /**
   * Switch to a model by name. Accepts:
   * - Shortnames: "opus", "sonnet", "gemini", "flash", "haiku"
   * - Full IDs: "claude-opus-4-6", "gemini-2.5-pro"
   * - Slot names: "primary", "reasoning", "cheap", "bulk"
   *
   * Optionally set effort: "opus high", "sonnet low"
   */
  setModel(input: string): { model: string; effort: EffortLevel } {
    const parts = input.trim().toLowerCase().split(/\s+/);
    const modelName = parts[0];
    const effortStr = parts[1] as EffortLevel | undefined;

    // Set effort if specified
    if (effortStr && (effortStr === 'high' || effortStr === 'medium' || effortStr === 'low')) {
      this._effort = effortStr;
    }

    // Check slot names first
    if (['primary', 'reasoning', 'cheap', 'bulk'].includes(modelName)) {
      const slot = modelName as ModelSlot;
      if (this.providers.has(slot)) {
        this.overrideSlot = slot;
        this.overrideProvider = null;
        this.overrideShortcut = null;
        const provider = this.providers.get(slot)!;
        return { model: provider.model, effort: this._effort };
      }
    }

    // Check model shortcuts
    const shortcut = MODEL_SHORTCUTS[modelName];
    if (shortcut) {
      // Resolve API key: local models (no baseUrl override) need none;
      // apiKeyEnv overrides the provider default (e.g. DashScope vs generic openai-compatible)
      const envKey = shortcut.apiKeyEnv ?? PROVIDER_ENV_KEYS[shortcut.provider];
      let resolvedApiKey: string;
      if (shortcut.baseUrl && !shortcut.apiKeyEnv) {
        resolvedApiKey = ''; // local llama.cpp — no key needed
      } else if (shortcut.apiKeyEnv) {
        // Explicit env var required (e.g. DASHSCOPE_API_KEY). Do NOT fall back
        // to primaryConfig.apiKey — that would send the wrong provider's key
        // and produce a confusing 401 from the remote API.
        const v = process.env[shortcut.apiKeyEnv];
        if (!v) {
          throw new Error(
            `Model "${modelName}" requires ${shortcut.apiKeyEnv} to be set in your environment.`,
          );
        }
        resolvedApiKey = v;
      } else {
        resolvedApiKey = process.env[envKey ?? ''] ?? this.primaryConfig.apiKey ?? '';
      }

      const config: ModelConfig = {
        provider: shortcut.provider,
        model: shortcut.model,
        contextWindow: shortcut.contextWindow,
        maxTokens: Math.min(EFFORT_CONFIG[this._effort].maxTokens, shortcut.maxOutputTokens ?? Infinity),
        auth: shortcut.auth ?? 'api_key',
        apiKey: resolvedApiKey,
        baseUrl: shortcut.baseUrl,
      };
      this.overrideProvider = createProvider(config, this.experimental);
      this.overrideSlot = null;
      this.overrideShortcut = modelName;
      return { model: shortcut.model, effort: this._effort };
    }

    throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_SHORTCUTS).filter(k => !k.includes('-')).join(', ')}`);
  }

  /** Clear any override, return to primary. */
  clearOverride(): void {
    this.overrideSlot = null;
    this.overrideProvider = null;
    this.overrideShortcut = null;
  }

  /** Stream from the current provider. Does NOT clear override (persistent until changed). */
  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    // Propagate effort-level thinking budget to providers that support it (Anthropic)
    const budget = EFFORT_CONFIG[this._effort].thinkingBudget;
    this.current.setThinkingBudget?.(budget);

    // Vision proxy: if the current model is text-only and the conversation
    // contains image blocks, describe each image via a vision-capable slot
    // and replace the block with the description. Lets GLM/DeepSeek/Qwen
    // "see" by borrowing another model's eyes.
    const effectiveMessages = await this.preprocessImagesForText(messages);

    yield* this.current.stream(effectiveMessages, systemPrompt, tools, signal);
  }

  // ── Vision proxy ────────────────────────────────────────────────────────
  // Strategy (best→worst, picks first available):
  //   1. ARIES_VISION_PROXY_MODEL env override via OpenRouter
  //   2. Qwen3-VL-235B-A22B-Instruct via OpenRouter — OCRBench ~920/1000 (April 2026),
  //      $0.20/M in, $0.88/M out. Best OCR accuracy per dollar for monospace/terminal text.
  //      Source: llm-stats.com/benchmarks/ocrbench + openrouter.ai pricing.
  //   3. OCR-specialized VLM configured in any slot (Qwen-VL, InternVL, Kimi-VL, MiniCPM-V)
  //   4. Any vision-capable slot (Gemini Flash, Claude, GPT-4o+)
  //   5. Error with config hint

  private visionDescriptionCache = new Map<string, string>();
  private transientVisionProvider: ModelProvider | null = null;

  /** Detect OCR-specialized open VLMs (not just any vision-capable model). */
  private static isOcrSpecialistModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    const specialists = ['qwen3-vl', 'qwen2.5-vl', 'qwen-vl', 'internvl', 'kimi-vl', 'minicpm-v', 'got-ocr'];
    return specialists.some(p => lower.startsWith(p) || lower.includes('/' + p));
  }

  /** Lazily create a transient OpenRouter vision provider (Qwen3-VL-235B by default). */
  private getTransientVisionProvider(): ModelProvider | null {
    if (this.transientVisionProvider) return this.transientVisionProvider;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    // Allow override for users who want a different OCR model on OpenRouter.
    const modelId = process.env.ARIES_VISION_PROXY_MODEL || 'qwen/qwen3-vl-235b-a22b-instruct';

    this.transientVisionProvider = createProvider({
      provider: 'openrouter',
      model: modelId,
      contextWindow: 262_144,
      maxTokens: 4_096,
      apiKey,
    }, this.experimental);
    return this.transientVisionProvider;
  }

  /** Pick the best available vision provider. */
  private findVisionProvider(): ModelProvider | null {
    // 1. OCR specialist already configured in a slot (user explicitly chose one)
    const order: ModelSlot[] = ['bulk', 'cheap', 'reasoning', 'primary'];
    for (const slot of order) {
      const p = this.providers.get(slot);
      if (p && ModelRouter.isOcrSpecialistModel(p.model)) return p;
    }
    // 2. Transient Qwen3-VL via OpenRouter — best OCR accuracy per dollar
    const transient = this.getTransientVisionProvider();
    if (transient) return transient;
    // 3. Any vision-capable slot (Gemini Flash, Claude, GPT)
    for (const slot of order) {
      const p = this.providers.get(slot);
      if (p && isVisionCapableModel(p.model)) return p;
    }
    return null;
  }

  /** Describe a single image block via a vision-capable provider. Cached by fingerprint. */
  private async describeImage(img: ImageContent): Promise<string> {
    const key = `${img.source.media_type}:${img.source.data.slice(0, 96)}:${img.source.data.length}`;
    const cached = this.visionDescriptionCache.get(key);
    if (cached) return cached;

    const provider = this.findVisionProvider();
    if (!provider) {
      throw new Error(
        `Image attached, but current model (${this.current.model}) is text-only and no ` +
        'vision-capable model is available. Either:\n' +
        '  • Set OPENROUTER_API_KEY (defaults to Qwen3-VL-235B for OCR), or\n' +
        '  • Configure a vision-capable model in any slot (bulk/cheap/reasoning).\n\n' +
        'Override the default vision proxy with ARIES_VISION_PROXY_MODEL.',
      );
    }

    // Two-stage prompt (transcribe → describe) beats single-stage on OCRBench.
    // Source: Qwen2.5-VL paper §4.2 (arxiv 2502.13923). Terminal-specific clause
    // prevents Claude/GPT from "correcting" real error messages into gibberish.
    const visionPrompt =
      'You are the vision layer for a text-only model that cannot see images. Your output will replace this image entirely.\n\n' +
      '1. TRANSCRIPTION: Transcribe every piece of visible text verbatim. Preserve exact whitespace, indentation, line breaks, and monospace alignment. Include ANSI box-drawing characters, terminal prompts, brackets, and punctuation exactly as shown. Do NOT correct apparent typos or error messages — they may be intentional.\n\n' +
      '2. DESCRIPTION: After the transcription, describe the layout, UI elements, window chrome, colors, highlighting, cursor position, and any non-text visual content (diagrams, charts, icons). Note which region each piece of text belongs to.\n\n' +
      'If this is a terminal/CLI screenshot, flag it explicitly and preserve prompt structure. If it is an IDE screenshot, identify the language and file. Be comprehensive and precise.';

    const visionMessages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: visionPrompt },
        img,
      ],
    }];

    let description = '';
    try {
      for await (const event of provider.stream(visionMessages, '', [], undefined)) {
        if (event.type === 'text') description += event.content;
      }
    } catch (err) {
      throw new Error(
        `Vision proxy (${provider.model}) failed to describe image: ${(err as Error).message}`,
      );
    }

    const cleaned = description.trim() || '[vision model returned empty description]';
    this.visionDescriptionCache.set(key, cleaned);
    return cleaned;
  }

  /** Replace image blocks with text descriptions when the current model is text-only. */
  private async preprocessImagesForText(messages: Message[]): Promise<Message[]> {
    // Fast path: any images at all?
    const hasImages = messages.some(m =>
      typeof m.content !== 'string' && (m.content as ContentBlock[]).some(b => b.type === 'image'),
    );
    if (!hasImages) return messages;

    // If the current model handles images natively, pass through.
    if (isVisionCapableModel(this.current.model)) return messages;

    // Otherwise, describe each image and substitute.
    const out: Message[] = [];
    let imageCounter = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') {
        out.push(m);
        continue;
      }
      const blocks = m.content as ContentBlock[];
      if (!blocks.some(b => b.type === 'image')) {
        out.push(m);
        continue;
      }
      const newBlocks: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type === 'image') {
          imageCounter += 1;
          const desc = await this.describeImage(b as ImageContent);
          newBlocks.push({
            type: 'text',
            text: `[Image ${imageCounter} — described by vision proxy]\n${desc}\n[/Image ${imageCounter}]`,
          });
        } else {
          newBlocks.push(b);
        }
      }
      out.push({ ...m, content: newBlocks });
    }
    return out;
  }

  /** Get a specific slot provider (e.g., cheap for compaction). */
  getProvider(slot: ModelSlot): ModelProvider | undefined {
    return this.providers.get(slot);
  }

  /**
   * Assign a model to a specific slot at runtime.
   * Usage: router.assignSlot('cheap', 'deepseek')
   */
  assignSlot(slot: ModelSlot, modelInput: string): void {
    const parts = modelInput.trim().toLowerCase().split(/\s+/);
    const modelName = parts[0];

    const shortcut = MODEL_SHORTCUTS[modelName];
    if (!shortcut) {
      throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_SHORTCUTS).filter(k => !k.includes('-')).join(', ')}`);
    }

    const config: ModelConfig = {
      provider: shortcut.provider,
      model: shortcut.model,
      contextWindow: shortcut.contextWindow,
      maxTokens: EFFORT_CONFIG[this._effort].maxTokens,
      apiKey: shortcut.baseUrl ? '' : undefined,
      baseUrl: shortcut.baseUrl,
    };
    this.providers.set(slot, createProvider(config, this.experimental));
  }

  /** Use the cheap slot (or primary as fallback) for utility calls. */
  async cheapCall(systemPrompt: string, messages: Message[]): Promise<string> {
    const provider = this.providers.get('cheap') ?? this.providers.get('primary');
    if (!provider) this.requirePrimary();
    let result = '';
    let inTok = 0, outTok = 0, cacheRead = 0, cacheWrite = 0;
    for await (const event of provider!.stream(messages, systemPrompt, [], undefined)) {
      if (event.type === 'text') result += event.content;
      if (event.type === 'usage') {
        inTok = event.inputTokens;
        outTok = event.outputTokens;
        cacheRead = event.cacheReadTokens ?? 0;
        cacheWrite = event.cacheWriteTokens ?? 0;
      }
    }
    // Notify any listeners (UsageTracker in app.tsx) about this call so
    // research/compaction/postflight spend shows up in /usage.
    for (const cb of this._cheapCallListeners) {
      try {
        cb({
          provider: provider!.name,
          model: provider!.model,
          inputTokens: inTok,
          outputTokens: outTok,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        });
      } catch { /* never let a listener error break a cheap call */ }
    }
    return result;
  }

  // ── Cheap-call usage listeners ─────────────────────────────────────────
  private _cheapCallListeners: Array<(u: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }) => void> = [];

  /** Subscribe to cheapCall usage events. Returns unsubscribe. */
  onCheapCallUsage(cb: (u: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }) => void): () => void {
    this._cheapCallListeners.push(cb);
    return () => {
      this._cheapCallListeners = this._cheapCallListeners.filter(f => f !== cb);
    };
  }

  /** Get info about the current model. */
  get info(): { name: string; model: string; contextWindow: number; slot: ModelSlot; effort: EffortLevel; shortcut: string | null } {
    const slot = this.overrideSlot ?? this.activeSlot;
    const provider = this.current;
    return {
      name: provider.name,
      model: provider.model,
      contextWindow: provider.contextWindow,
      slot,
      effort: this._effort,
      shortcut: this.overrideShortcut,
    };
  }

  /** List all configured slots. */
  get slots(): { slot: ModelSlot; name: string; model: string }[] {
    return Array.from(this.providers.entries()).map(([slot, p]) => ({
      slot,
      name: p.name,
      model: p.model,
    }));
  }

  /** List available model shortnames. */
  static get availableModels(): string[] {
    return Object.keys(MODEL_SHORTCUTS).filter(k => !k.includes('-'));
  }
}

