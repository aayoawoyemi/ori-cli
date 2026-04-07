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
      const encoded = encodeURIComponent(query);
      const response = await fetch(
        `https://html.duckduckgo.com/html/?q=${encoded}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `q=${encoded}`,
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!response.ok) {
        return {
          id: '', name: this.name,
          output: `Search failed: HTTP ${response.status}`,
          isError: true,
        };
      }

      const html = await response.text();
      const results = this.parseDDGResults(html, maxResults);

      if (results.length === 0) {
        return {
          id: '', name: this.name,
          output: `No results found for: ${query}. Try WebFetch with a specific URL instead.`,
          isError: false,
        };
      }

      const lines = results.map(r =>
        `${r.title}\n${r.url}\n${r.snippet}\n`
      );

      return { id: '', name: this.name, output: lines.join('\n'), isError: false };
    } catch (err) {
      return {
        id: '', name: this.name,
        output: `Search failed: ${(err as Error).message}`,
        isError: true,
      };
    }
  }

  private parseDDGResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    // DDG HTML search results are in <div class="result ..."> blocks
    // Each contains:
    //   - Title in <a class="result__a"> ... </a>
    //   - URL in <a class="result__url" href="..."> ... </a>
    //   - Snippet in <a class="result__snippet"> ... </a>  (or <td class="result__snippet">)

    // Split by result blocks
    const resultBlocks = html.split(/class="result\s/g).slice(1);

    for (const block of resultBlocks) {
      if (results.length >= maxResults) break;

      // Extract title from result__a
      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? this.stripTags(titleMatch[1]).trim() : '';

      // Extract URL — DDG wraps actual URLs in uddg= param or result__url text
      let url = '';
      const urlTextMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/);
      if (urlTextMatch) {
        url = this.stripTags(urlTextMatch[1]).trim();
        if (!url.startsWith('http')) url = 'https://' + url;
      }
      // Also try href with uddg redirect
      if (!url || url === 'https://') {
        const hrefMatch = block.match(/href="[^"]*uddg=([^&"]+)/);
        if (hrefMatch) {
          url = decodeURIComponent(hrefMatch[1]);
        }
      }

      // Extract snippet from result__snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/);
      const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : '';

      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return results;
  }

  private stripTags(html: string): string {
    return html
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }
}
