import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class WebFetchTool implements Tool {
  readonly name = 'WebFetch';
  readonly description = 'Fetch a web page and return its content as cleaned text/markdown. Handles HTML → readable text conversion. Use for reading articles, docs, READMEs, etc.';
  readonly readOnly = true;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to fetch.',
          },
          maxLength: {
            type: 'number',
            description: 'Max characters to return (default: 50000).',
          },
        },
        required: ['url'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const url = input.url as string;
    const maxLength = (input.maxLength as number) || 50_000;

    try {
      // Try Jina Reader first (handles JS rendering, returns markdown)
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          'Accept': 'text/markdown',
          'X-No-Cache': 'true',
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        // Fallback to direct fetch
        return await this.directFetch(url, maxLength);
      }

      let content = await response.text();
      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + `\n\n... (truncated, ${content.length} total chars)`;
      }

      return { id: '', name: this.name, output: content, isError: false };
    } catch {
      // Fallback to direct fetch
      return await this.directFetch(url, maxLength);
    }
  }

  private async directFetch(url: string, maxLength: number): Promise<ToolResult> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Aries-CLI/0.1.0' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return {
          id: '', name: this.name,
          output: `HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      let content = await response.text();

      // Basic HTML → text cleaning
      content = content
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();

      if (content.length > maxLength) {
        content = content.slice(0, maxLength) + `\n\n... (truncated)`;
      }

      return { id: '', name: this.name, output: content, isError: false };
    } catch (err) {
      return {
        id: '', name: this.name,
        output: `Fetch failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
