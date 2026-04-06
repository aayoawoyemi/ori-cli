/**
 * OpenAI-compatible provider.
 *
 * Works with any API that implements the /v1/chat/completions endpoint:
 * - OpenAI (GPT-4o, GPT-5, o4-mini)
 * - Kimi K2 / K2.5 (Moonshot)
 * - DeepSeek (V3, R1)
 * - GLM-5 (Zhipu / z.ai)
 * - MiniMax M2.7
 * - Groq (Llama, Mixtral)
 * - Fireworks
 * - OpenRouter (universal gateway)
 * - Ollama (local)
 * - LM Studio (local)
 * - vLLM (local)
 * - Together AI
 * - Any OpenAI-compatible endpoint
 *
 * Config:
 *   provider: 'openai-compatible'
 *   model: 'kimi-k2'
 *   baseUrl: 'https://api.moonshot.cn/v1'
 *   apiKey: 'sk-...'
 */

import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock } from '../types.js';
import type { ModelConfig } from '../../config/types.js';

// ── Message Conversion ─────────────────────────────────────────────────────

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

interface OAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

function toOAIMessages(messages: Message[], systemPrompt: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: 'system', content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        // Assistant message with tool calls
        let text = '';
        const toolCalls: OAIToolCall[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') text += block.text;
          else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) },
            });
          }
        }
        const assistantMsg: OAIMessage = { role: 'assistant', content: text || null };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        result.push(assistantMsg);
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        // User message with images and/or tool results
        const contentParts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') {
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
            });
          } else if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
        if (contentParts.length > 0) {
          result.push({ role: 'user', content: contentParts as unknown as string });
        }
      }
    }
  }

  return result;
}

function toOAITools(tools: ToolDefinition[]): OAITool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ── SSE Parsing ────────────────────────────────────────────────────────────

interface SSEChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ── Provider ───────────────────────────────────────────────────────────────

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  readonly contextWindow: number;
  private baseUrl: string;
  private apiKey: string;
  private maxTokens: number;

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 128_000;
    this.maxTokens = config.maxTokens ?? 16_384;
    this.name = `openai-compatible:${config.model}`;

    // Resolve base URL: explicit config > provider-specific default
    const providerDefaults: Record<string, { url: string; envKey: string }> = {
      'openai':             { url: 'https://api.openai.com/v1',              envKey: 'OPENAI_API_KEY' },
      'openai-compatible':  { url: 'https://api.openai.com/v1',              envKey: 'OPENAI_API_KEY' },
      'deepseek':           { url: 'https://api.deepseek.com/v1',            envKey: 'DEEPSEEK_API_KEY' },
      'moonshot':           { url: 'https://api.moonshot.cn/v1',             envKey: 'MOONSHOT_API_KEY' },
      'groq':               { url: 'https://api.groq.com/openai/v1',        envKey: 'GROQ_API_KEY' },
      'fireworks':          { url: 'https://api.fireworks.ai/inference/v1',  envKey: 'FIREWORKS_API_KEY' },
      'openrouter':         { url: 'https://openrouter.ai/api/v1',          envKey: 'OPENROUTER_API_KEY' },
      'ollama':             { url: 'http://localhost:11434/v1',              envKey: '' },
      // llama.cpp server (llama-server) — OpenAI-compatible on port 8080
      'llamacpp':           { url: 'http://localhost:8080/v1',               envKey: '' },
      'custom':             { url: 'https://api.openai.com/v1',              envKey: 'OPENAI_API_KEY' },
    };

    const defaults = providerDefaults[config.provider] ?? providerDefaults['openai-compatible']!;

    this.baseUrl = config.baseUrl
      || process.env.OPENAI_BASE_URL
      || defaults.url;

    // Strip trailing slash and /chat/completions if present
    this.baseUrl = this.baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

    // Resolve API key: explicit config > provider-specific env > generic fallbacks
    this.apiKey = config.apiKey
      || (defaults.envKey ? (process.env[defaults.envKey] ?? '') : '')
      || process.env.OPENAI_API_KEY
      || '';
  }

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const oaiMessages = toOAIMessages(messages, systemPrompt);
    const oaiTools = toOAITools(tools);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: oaiMessages,
      max_tokens: this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (oaiTools.length > 0) {
      body.tools = oaiTools;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Some providers need extra headers
    if (this.baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/ori-memory/aries';
      headers['X-Title'] = 'Ori CLI';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`${response.status} ${errText}`);
    }

    if (!response.body) {
      throw new Error('No response body (streaming not supported by this endpoint?)');
    }

    // Parse SSE stream
    const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') continue;

          let chunk: SSEChunk;
          try {
            chunk = JSON.parse(data) as SSEChunk;
          } catch {
            continue;
          }

          // Usage (some providers send this in the final chunk)
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }

          const choice = chunk.choices?.[0];
          if (!choice?.delta) continue;

          // Text content
          if (choice.delta.content) {
            yield { type: 'text', content: choice.delta.content };
          }

          // Tool calls (streamed incrementally)
          if (choice.delta.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index;

              if (tc.id) {
                // New tool call starting
                pendingToolCalls.set(idx, { id: tc.id, name: tc.function?.name ?? '', args: '' });
                yield { type: 'tool_use_start', id: tc.id, name: tc.function?.name ?? '' };
              }

              const pending = pendingToolCalls.get(idx);
              if (pending) {
                if (tc.function?.name && !pending.name) pending.name = tc.function.name;
                if (tc.function?.arguments) {
                  pending.args += tc.function.arguments;
                  yield { type: 'tool_use_delta', id: pending.id, delta: tc.function.arguments };
                }
              }
            }
          }

          // Finish reason — flush pending tool calls
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
            for (const [idx, pending] of pendingToolCalls) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(pending.args || '{}') as Record<string, unknown>;
              } catch { /* empty */ }
              yield { type: 'tool_use_end', id: pending.id, input };
            }
            pendingToolCalls.clear();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: 'usage',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
    yield { type: 'done' };
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
