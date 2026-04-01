import type { ModelProvider, Message, ToolDefinition, StreamEvent, ModelSlot } from './types.js';
import type { RouterConfig, ModelConfig } from '../config/types.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';

// ── Effort Levels ───────────────────────────────────────────────────────────

export type EffortLevel = 'high' | 'medium' | 'low';

const EFFORT_CONFIG: Record<EffortLevel, { maxTokens: number; thinking: boolean }> = {
  high:   { maxTokens: 32_768, thinking: true },
  medium: { maxTokens: 16_384, thinking: false },
  low:    { maxTokens: 4_096,  thinking: false },
};

// ── Model Shortnames ────────────────────────────────────────────────────────
// Map friendly names to provider + model configs

interface ModelShortcut {
  provider: ModelConfig['provider'];
  model: string;
  contextWindow: number;
  auth?: 'oauth' | 'api_key';
}

const MODEL_SHORTCUTS: Record<string, ModelShortcut> = {
  // Anthropic
  'opus':     { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 1_000_000 },
  'sonnet':   { provider: 'anthropic', model: 'claude-sonnet-4-6', contextWindow: 200_000 },
  'haiku':    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', contextWindow: 200_000 },
  // Google
  'gemini':   { provider: 'google', model: 'gemini-2.5-pro', contextWindow: 1_000_000 },
  'flash':    { provider: 'google', model: 'gemini-2.5-flash', contextWindow: 1_000_000 },
  // Full model IDs also work
  'claude-opus-4-6':    { provider: 'anthropic', model: 'claude-opus-4-6', contextWindow: 1_000_000 },
  'claude-sonnet-4-6':  { provider: 'anthropic', model: 'claude-sonnet-4-6', contextWindow: 200_000 },
  'gemini-2.5-pro':     { provider: 'google', model: 'gemini-2.5-pro', contextWindow: 1_000_000 },
  'gemini-2.5-flash':   { provider: 'google', model: 'gemini-2.5-flash', contextWindow: 1_000_000 },
};

// ── Provider Factory ────────────────────────────────────────────────────────

function createProvider(config: ModelConfig): ModelProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'google':
      return new GoogleProvider(config);
    default:
      throw new Error(`Unsupported provider: ${config.provider}. Available: anthropic, google`);
  }
}

// ── Model Router ────────────────────────────────────────────────────────────

export class ModelRouter {
  private providers = new Map<ModelSlot, ModelProvider>();
  private activeSlot: ModelSlot = 'primary';
  private overrideSlot: ModelSlot | null = null;
  private overrideProvider: ModelProvider | null = null;
  private _effort: EffortLevel = 'medium';
  private primaryConfig: ModelConfig;

  constructor(config: RouterConfig) {
    this.primaryConfig = config.primary;
    this.providers.set('primary', createProvider(config.primary));
    if (config.reasoning) this.providers.set('reasoning', createProvider(config.reasoning));
    if (config.cheap) this.providers.set('cheap', createProvider(config.cheap));
    if (config.bulk) this.providers.set('bulk', createProvider(config.bulk));
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
      const config: ModelConfig = {
        provider: shortcut.provider,
        model: shortcut.model,
        contextWindow: shortcut.contextWindow,
        maxTokens: EFFORT_CONFIG[this._effort].maxTokens,
        auth: shortcut.auth ?? this.primaryConfig.auth,
        apiKey: this.primaryConfig.apiKey,
      };
      this.overrideProvider = createProvider(config);
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
    yield* this.current.stream(messages, systemPrompt, tools, signal);
  }

  /** Get a specific slot provider (e.g., cheap for compaction). */
  getProvider(slot: ModelSlot): ModelProvider | undefined {
    return this.providers.get(slot);
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
