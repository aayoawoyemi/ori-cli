import type { Tool } from './types.js';
import type { ToolDefinition, ToolResult } from '../router/types.js';

/**
 * Web search with resilient multi-backend fallback:
 *
 *   1. Tavily  (best quality, needs TAVILY_API_KEY)
 *   2. Brave   (free 2k/mo, needs BRAVE_SEARCH_API_KEY)
 *   3. DDG JSON instant-answer API  (no key, limited topic coverage)
 *   4. DDG HTML scraping  (no key, fragile — last resort)
 *
 * DDG HTML scraping was the only backend before. It returns HTTP 202 +
 * CAPTCHA pages intermittently, causing silent "no results" failures.
 * The fallback chain means at least one backend will almost always work.
 *
 * Future: For Anthropic models, use server-side `web_search_20250305`
 * tool (zero config, server handles everything). Requires stream parser
 * changes — tracked separately.
 */
export class WebSearchTool implements Tool {
  readonly name = 'WebSearch';
  readonly description = 'Search the web and return results with titles, URLs, and snippets. Uses Brave/Tavily if configured, DuckDuckGo otherwise.';
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

    const backends: Array<{ name: string; fn: () => Promise<ToolResult | null> }> = [];

    if (process.env.TAVILY_API_KEY) {
      backends.push({ name: 'tavily', fn: () => this.tavilySearch(query, maxResults) });
    }
    if (process.env.BRAVE_SEARCH_API_KEY) {
      backends.push({ name: 'brave', fn: () => this.braveSearch(query, maxResults) });
    }
    backends.push({ name: 'ddg-json', fn: () => this.ddgJsonSearch(query, maxResults) });
    backends.push({ name: 'ddg-html', fn: () => this.ddgHtmlSearch(query, maxResults) });

    const errors: string[] = [];
    for (const backend of backends) {
      try {
        const result = await backend.fn();
        if (result && !result.isError && result.output && !result.output.startsWith('No results found')) {
          return result;
        }
      } catch (err) {
        errors.push(`${backend.name}: ${(err as Error).message}`);
      }
    }

    return {
      id: '', name: this.name,
      output: `Web search failed for "${query}". All backends exhausted.\n${errors.join('\n')}\nTip: set BRAVE_SEARCH_API_KEY (free at brave.com/search/api) or TAVILY_API_KEY for reliable results.`,
      isError: true,
    };
  }

  // ── Tavily ────────────────────────────────────────────────────────────

  private async tavilySearch(query: string, maxResults: number): Promise<ToolResult | null> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        include_answer: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      answer?: string;
      results: Array<{ title: string; url: string; content: string }>;
    };

    if (!data.results?.length) return null;

    const lines: string[] = [];
    if (data.answer) lines.push(`Answer: ${data.answer}\n`);
    for (const r of data.results.slice(0, maxResults)) {
      lines.push(`${r.title}\n${r.url}\n${r.content}\n`);
    }

    return { id: '', name: this.name, output: lines.join('\n'), isError: false };
  }

  // ── Brave Search ──────────────────────────────────────────────────────

  private async braveSearch(query: string, maxResults: number): Promise<ToolResult | null> {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encoded}&count=${maxResults}`,
      {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY!,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) return null;

    const data = await response.json() as {
      web?: { results: Array<{ title: string; url: string; description: string }> };
    };

    const results = data.web?.results;
    if (!results?.length) return null;

    const lines = results.slice(0, maxResults).map(r =>
      `${r.title}\n${r.url}\n${r.description}\n`
    );

    return { id: '', name: this.name, output: lines.join('\n'), isError: false };
  }

  // ── DuckDuckGo JSON API ───────────────────────────────────────────────

  private async ddgJsonSearch(query: string, maxResults: number): Promise<ToolResult | null> {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
      {
        headers: { 'User-Agent': 'Ori-CLI/0.1 (search tool)' },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) return null;

    const data = await response.json() as {
      AbstractText?: string;
      AbstractURL?: string;
      Heading?: string;
      RelatedTopics?: Array<{
        Text?: string;
        FirstURL?: string;
        Topics?: Array<{ Text?: string; FirstURL?: string }>;
      }>;
    };

    const lines: string[] = [];

    if (data.AbstractText && data.AbstractURL) {
      lines.push(`${data.Heading || query}\n${data.AbstractURL}\n${data.AbstractText}\n`);
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (lines.length >= maxResults) break;
        if (topic.Text && topic.FirstURL) {
          lines.push(`${topic.Text.slice(0, 200)}\n${topic.FirstURL}\n`);
        }
        if (topic.Topics) {
          for (const sub of topic.Topics) {
            if (lines.length >= maxResults) break;
            if (sub.Text && sub.FirstURL) {
              lines.push(`${sub.Text.slice(0, 200)}\n${sub.FirstURL}\n`);
            }
          }
        }
      }
    }

    if (lines.length === 0) return null;
    return { id: '', name: this.name, output: lines.join('\n'), isError: false };
  }

  // ── DuckDuckGo HTML Scraping (last resort) ────────────────────────────

  private async ddgHtmlSearch(query: string, maxResults: number): Promise<ToolResult | null> {
    const encoded = encodeURIComponent(query);

    const response = await fetch(
      `https://html.duckduckgo.com/html/?q=${encoded}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok || response.status === 202) return null;

    const html = await response.text();
    if (!html.includes('result__a')) return null;

    const results = this.parseDDGResults(html, maxResults);
    if (results.length === 0) return null;

    const lines = results.map(r => `${r.title}\n${r.url}\n${r.snippet}\n`);
    return { id: '', name: this.name, output: lines.join('\n'), isError: false };
  }

  private parseDDGResults(html: string, maxResults: number): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const resultBlocks = html.split(/class="result\s/g).slice(1);

    for (const block of resultBlocks) {
      if (results.length >= maxResults) break;

      const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
      const title = titleMatch ? this.stripTags(titleMatch[1]).trim() : '';

      let url = '';
      const urlTextMatch = block.match(/class="result__url"[^>]*>([\s\S]*?)<\/a>/);
      if (urlTextMatch) {
        url = this.stripTags(urlTextMatch[1]).trim();
        if (!url.startsWith('http')) url = 'https://' + url;
      }
      if (!url || url === 'https://') {
        const hrefMatch = block.match(/href="[^"]*uddg=([^&"]+)/);
        if (hrefMatch) url = decodeURIComponent(hrefMatch[1]);
      }

      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td)>/);
      const snippet = snippetMatch ? this.stripTags(snippetMatch[1]).trim() : '';

      if (title && url) results.push({ title, url, snippet });
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
