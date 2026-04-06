import { GoogleGenAI, type Content, type Tool as GeminiTool, type Part } from '@google/genai';
import type { ModelProvider, Message, ToolDefinition, StreamEvent, ContentBlock } from '../types.js';
import type { ModelConfig } from '../../config/types.js';

/** Convert our messages to Gemini Content format. */
function toGeminiContents(messages: Message[], toolNameById?: Map<string, string>): Content[] {
  const contents: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const parts: Part[] = [];
      if (typeof msg.content === 'string') {
        if (msg.content) parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: { name: block.name, args: block.input },
            });
          }
        }
      }
      if (parts.length > 0) {
        contents.push({ role: 'model', parts });
      }
    } else if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        contents.push({ role: 'user', parts: [{ text: msg.content }] });
      } else {
        const parts: Part[] = [];
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            });
          } else if (block.type === 'tool_result') {
            // Gemini requires the function NAME, not the ID
            const funcName = toolNameById?.get(block.tool_use_id) ?? block.tool_use_id;
            parts.push({
              functionResponse: {
                name: funcName,
                response: { result: block.content },
              },
            });
          }
        }
        if (parts.length > 0) {
          contents.push({ role: 'user', parts });
        }
      }
    }
  }

  return contents;
}

/** Convert our tool definitions to Gemini format. */
function toGeminiTools(tools: ToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return [];
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    })),
  }];
}

export class GoogleProvider implements ModelProvider {
  readonly name = 'google';
  readonly model: string;
  readonly contextWindow: number;
  private client: GoogleGenAI;
  // Track tool call IDs → function names for correlating results
  private toolNameById = new Map<string, string>();

  constructor(config: ModelConfig) {
    this.model = config.model;
    this.contextWindow = config.contextWindow ?? 1_000_000;
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Google API key required (set GOOGLE_API_KEY or GEMINI_API_KEY)');
    this.client = new GoogleGenAI({ apiKey });
  }

  async *stream(
    messages: Message[],
    systemPrompt: string,
    tools: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const contents = toGeminiContents(messages, this.toolNameById);
    const geminiTools = toGeminiTools(tools);

    const response = await this.client.models.generateContentStream({
      model: this.model,
      contents,
      config: {
        systemInstruction: systemPrompt,
        ...(geminiTools.length > 0 && { tools: geminiTools }),
      },
    });

    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of response) {
      // Usage metadata
      if (chunk.usageMetadata) {
        inputTokens = chunk.usageMetadata.promptTokenCount ?? 0;
        outputTokens = chunk.usageMetadata.candidatesTokenCount ?? 0;
      }

      if (!chunk.candidates?.[0]?.content?.parts) continue;

      for (const part of chunk.candidates[0].content.parts) {
        if (part.text) {
          yield { type: 'text', content: part.text };
        }
        if (part.functionCall) {
          const id = `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const name = part.functionCall.name!;
          const input = (part.functionCall.args ?? {}) as Record<string, unknown>;
          // Track ID → name so tool results can use the correct function name
          this.toolNameById.set(id, name);
          yield { type: 'tool_use_start', id, name };
          yield { type: 'tool_use_end', id, input };
        }
      }
    }

    yield { type: 'usage', inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
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
