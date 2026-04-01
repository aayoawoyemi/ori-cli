import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

export class WebSearchTool implements Tool {
  readonly name = 'WebSearch';
  readonly description = 'Search the web and return results with titles, URLs, and snippets. Uses DuckDuckGo (no API key needed) or Tavily if configured.';
  readonly readOnly = true;

  definition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query.',
          },
          maxResults: {
            type: 'number',
            description: 'Maximum number of results (default: 10).',
          },
        },
        required: ['query'],
      },
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const query = input.query as string;
    const maxResults = (input.maxResults as number) || 10;

    // Try Tavily if API key is set
    if (process.env.TAVILY_API_KEY) {
      return await this.tavilySearch(query, maxResults);
    }

    // Fallback: DuckDuckGo HTML scraping (no API key needed)
    return await this.duckDuckGoSearch(query, maxResults);
  }

  private async tavilySearch(query: string, maxResults: number): Promise<ToolResult> {
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key: process.env.TAVILY_API_KEY,
          query,
          max_results: maxResults,
          include_answer: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return await this.duckDuckGoSearch(query, maxResults);
      }

      const data = await response.json() as {
        answer?: string;
        results: Array<{ title: string; url: string; content: string }>;
      };

      const lines: string[] = [];
      if (data.answer) {
        lines.push(`Answer: ${data.answer}\n`);
      }
      for (const r of data.results.slice(0, maxResults)) {
        lines.push(`${r.title}\n${r.url}\n${r.content}\n`);
      }

      return { id: '', name: this.name, output: lines.join('\n'), isError: false };
    } catch {
      return await this.duckDuckGoSearch(query, maxResults);
    }
  }

  private async duckDuckGoSearch(query: string, maxResults: number): Promise<ToolResult> {
    try {
      // DuckDuckGo instant answer API (limited but no key needed)
      const encoded = encodeURIComponent(query);
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
        { signal: AbortSignal.timeout(10_000) },
      );

      if (!response.ok) {
        return {
          id: '', name: this.name,
          output: `Search failed: HTTP ${response.status}`,
          isError: true,
        };
      }

      const data = await response.json() as {
        Abstract?: string;
        AbstractURL?: string;
        AbstractSource?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const lines: string[] = [];

      if (data.Abstract) {
        lines.push(`${data.AbstractSource}: ${data.Abstract}\n${data.AbstractURL}\n`);
      }

      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, maxResults)) {
          if (topic.Text && topic.FirstURL) {
            lines.push(`${topic.Text}\n${topic.FirstURL}\n`);
          }
        }
      }

      if (lines.length === 0) {
        return {
          id: '', name: this.name,
          output: `No results found for: ${query}. Try WebFetch with a specific URL instead.`,
          isError: false,
        };
      }

      return { id: '', name: this.name, output: lines.join('\n'), isError: false };
    } catch (err) {
      return {
        id: '', name: this.name,
        output: `Search failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
