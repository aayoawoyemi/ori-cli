import type { ModelProvider, Message, ToolDefinition, StreamEvent, ModelSlot } from './types.js';
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
  'opus':     { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 1_000_000 },
  'sonnet':   { provider: 'anthropic', model: 'claude-sonnet-4-6', contextWindow: 200_000 },
  'haiku':    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000 },

  // â”€â”€ Google â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'gemini':   { provider: 'google', model: 'gemini-2.5-pro', contextWindow: 1_000_000 },
  'flash':    { provider: 'google', model: 'gemini-2.5-flash', contextWindow: 1_000_000 },

  // â”€â”€ OpenAI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  'gpt4o':    { provider: 'openai', model: 'gpt-4o', contextWindow: 128_000 },
  'gpt5':     { provider: 'openai', model: 'gpt-5', contextWindow: 1_000_000 },
  'o4-mini':  { provider: 'openai', model: 'o4-mini', contextWindow: 200_000 },

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

  // Paid OpenRouter models (much cheaper than direct APIs)
  'qwen3.6-or':    { provider: 'openrouter', model: 'qwen/qwen3.6-plus',            contextWindow: 131_072 },
  'minimax':       { provider: 'openrouter', model: 'minimax/minimax-m2.7',         contextWindow: 1_000_000 },
  'deepseek-v3':   { provider: 'openrouter', model: 'deepseek/deepseek-v3.2',       contextWindow: 131_072 },
  'gemini-flash':  { provider: 'openrouter', model: 'google/gemini-3-flash-preview', contextWindow: 1_000_000 },
  'glm5':          { provider: 'openrouter', model: 'zai-org/glm-5',               contextWindow: 128_000 },

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
      return new OpenAICompatibleProvider(config);
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
  private _effort: EffortLevel = 'medium';
  private primaryConfig: ModelConfig;
  private experimental?: ExperimentalConfig;

  constructor(config: RouterConfig, experimental?: ExperimentalConfig) {
    this.primaryConfig = config.primary;
    this.experimental = experimental;
    this.providers.set('primary', createProvider(config.primary, this.experimental));
    if (config.reasoning) this.providers.set('reasoning', createProvider(config.reasoning, this.experimental));
    if (config.cheap) this.providers.set('cheap', createProvider(config.cheap, this.experimental));
    if (config.bulk) this.providers.set('bulk', createProvider(config.bulk, this.experimental));
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
    return this.providers.get(slot) ?? this.providers.get('primary')!;
  }

  /** Override with a slot name (primary/reasoning/cheap/bulk). */
  setSlotOverride(slot: ModelSlot): void {
    if (!this.providers.has(slot)) {
      throw new Error(`No provider configured for slot: ${slot}`);
    }
    this.overrideSlot = slot;
    this.overrideProvider = null;
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
      const resolvedApiKey = (shortcut.baseUrl && !shortcut.apiKeyEnv)
        ? ''  // local llama.cpp â€” no key needed
        : (process.env[envKey ?? ''] ?? this.primaryConfig.apiKey ?? '');

      const config: ModelConfig = {
        provider: shortcut.provider,
        model: shortcut.model,
        contextWindow: shortcut.contextWindow,
        maxTokens: Math.min(EFFORT_CONFIG[this._effort].maxTokens, shortcut.maxOutputTokens ?? Infinity),
        auth: shortcut.auth ?? this.primaryConfig.auth,
        apiKey: resolvedApiKey,
        baseUrl: shortcut.baseUrl,
      };
      this.overrideProvider = createProvider(config, this.experimental);
      this.overrideSlot = null;
      return { model: shortcut.model, effort: this._effort };
    }

    throw new Error(`Unknown model: ${modelName}. Available: ${Object.keys(MODEL_SHORTCUTS).filter(k => !k.includes('-')).join(', ')}`);
  }

  /** Clear any override, return to primary. */
  clearOverride(): void {
    this.overrideSlot = null;
    this.overrideProvider = null;
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
    yield* this.current.stream(messages, systemPrompt, tools, signal);
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
    const provider = this.providers.get('cheap') ?? this.providers.get('primary')!;
    let result = '';
    for await (const event of provider.stream(messages, systemPrompt, [], undefined)) {
      if (event.type === 'text') result += event.content;
    }
    return result;
  }

  /** Get info about the current model. */
  get info(): { name: string; model: string; contextWindow: number; slot: ModelSlot; effort: EffortLevel } {
    const slot = this.overrideSlot ?? this.activeSlot;
    const provider = this.current;
    return {
      name: provider.name,
      model: provider.model,
      contextWindow: provider.contextWindow,
      slot,
      effort: this._effort,
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


