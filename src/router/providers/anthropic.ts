import Anthropic from '@anthropic-ai/sdk';
import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock } from '../types.js';
import type { ModelConfig } from '../../config/types.js';
import { loadOAuthCredentials, isTokenExpired, refreshOAuthToken, type OAuthCredentials } from '../../auth/oauth.js';
import { buildBillingHeader, computeCch, VERSION } from '../../auth/cch.js';
import { getMessageText } from '../../utils/messages.js';

/** Convert our Message format to Anthropic's format. */
function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const content: Anthropic.ContentBlockParam[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content) content.push({ type: 'text', text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }
      }
      if (content.length > 0) {
        result.push({ role: 'assistant', content });
      }
    } else {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_result') {
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error,
            });
          }
        }
        if (content.length > 0) {
          result.push({ role: 'user', content });
        }
      }
    }
  }

  return result;
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }));
}

// ── OAuth + cch signing for subscription-based access ───────────────────────

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly model: string;
  readonly contextWindow: number;
  private client: Anthropic;
  private maxTokens: number;
  private useOAuth: boolean;
  private oauthCreds: OAuthCredentials | null = null;

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 200_000;
    this.maxTokens = config.maxTokens ?? 16_384;
    this.useOAuth = config.auth === 'oauth';

    if (this.useOAuth) {
      // Load OAuth token from Claude Code's credential store
      this.oauthCreds = loadOAuthCredentials();
      if (!this.oauthCreds) {
        throw new Error(
          'OAuth mode requires Claude Code credentials. Run Claude Code once to authenticate, ' +
          'or set ANTHROPIC_OAUTH_TOKEN environment variable.'
        );
      }
      this.client = new Anthropic({
        apiKey: this.oauthCreds.accessToken, // SDK uses apiKey field for Bearer auth too
        ...(config.baseUrl && { baseURL: config.baseUrl }),
      });
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
        ...(config.baseUrl && { baseURL: config.baseUrl }),
      });
    }
  }

  /** Ensure OAuth token is fresh. */
  private async ensureToken(): Promise<void> {
    if (!this.useOAuth || !this.oauthCreds) return;

    if (isTokenExpired(this.oauthCreds)) {
      const refreshed = await refreshOAuthToken(this.oauthCreds);
      if (refreshed) {
        this.oauthCreds = refreshed;
        this.client = new Anthropic({ apiKey: refreshed.accessToken });
      }
    }
  }

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    await this.ensureToken();

    const anthropicMessages = toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(tools);

    // Build system array
    let systemArray: Anthropic.TextBlockParam[];

    if (this.useOAuth) {
      // OAuth mode: inject billing header as first system block
      const firstUserMsg = messages.find(m => m.role === 'user');
      const firstUserText = firstUserMsg ? getMessageText(firstUserMsg) : '';
      const billingHeader = buildBillingHeader(firstUserText);

      systemArray = [
        { type: 'text', text: billingHeader },
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ];
    } else {
      systemArray = [
        { type: 'text', text: systemPrompt },
      ];
    }

    // Build request params
    const requestParams: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemArray,
      messages: anthropicMessages,
      ...(anthropicTools.length > 0 && { tools: anthropicTools }),
    };

    if (this.useOAuth) {
      // OAuth mode: we need to compute cch over the serialized body.
      // The SDK handles serialization internally, so we compute cch
      // by serializing our params, computing the hash, then sending
      // with the corrected billing header.
      //
      // Note: The ideal approach would intercept the fetch call.
      // For V0, we compute cch over a serialized approximation.
      // This works because the hash covers the JSON body and we
      // control the serialization order.
      const bodyJson = JSON.stringify(requestParams, null, 0);
      const { cch, signedBody } = await computeCch(bodyJson);

      // Update the billing header in the system array with the computed cch
      const billingText = (systemArray[0] as Anthropic.TextBlockParam).text;
      systemArray[0] = {
        type: 'text',
        text: billingText.replace('cch=00000', `cch=${cch}`),
      };

      // Rebuild params with signed billing header
      requestParams.system = systemArray;
    }

    // Build headers for OAuth mode
    const streamOptions: Record<string, unknown> = {};
    if (signal) streamOptions.signal = signal;

    if (this.useOAuth) {
      streamOptions.headers = {
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,adaptive-thinking-2026-01-28,research-preview-2026-02-01',
        'user-agent': `aries-cli/0.1.0 (external, cli)`,
        'x-app': 'cli',
      };
    }

    const stream = this.client.messages.stream(
      requestParams,
      streamOptions as Anthropic.RequestOptions,
    );

    const toolInputBuffers = new Map<string, { name: string; json: string }>();

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'tool_use') {
          const block = event.content_block;
          toolInputBuffers.set(block.id, { name: block.name, json: '' });
          yield { type: 'tool_use_start', id: block.id, name: block.name };
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', content: event.delta.text };
        } else if (event.delta.type === 'input_json_delta') {
          const partial = event.delta.partial_json;
          for (const [id, buf] of toolInputBuffers) {
            buf.json += partial;
            yield { type: 'tool_use_delta', id, delta: partial };
          }
        }
      } else if (event.type === 'content_block_stop') {
        for (const [id, buf] of toolInputBuffers) {
          try {
            const input = JSON.parse(buf.json || '{}') as Record<string, unknown>;
            yield { type: 'tool_use_end', id, input };
          } catch {
            yield { type: 'tool_use_end', id, input: {} };
          }
        }
        toolInputBuffers.clear();
      } else if (event.type === 'message_stop') {
        const finalMessage = await stream.finalMessage();
        yield {
          type: 'usage',
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
        };
        yield { type: 'done' };
      }
    }
  }

  estimateTokens(messages: Message[]): number {
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') chars += block.text.length;
          else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length;
          else if (block.type === 'tool_result') chars += block.content.length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }
}
