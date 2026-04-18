import type { DiscoveredSource } from '../types.js';

const EXA_API = 'https://api.exa.ai';
const EXA_KEY = process.env.EXA_API_KEY;

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': EXA_KEY ?? '',
  };
}

/**
 * Search Exa's neural index for web content — blogs, docs, articles, Stack Overflow,
 * GitHub, Reddit threads, and anything else on the open web.
 * Uses type "auto" which balances keyword and neural matching.
 */
export async function searchExa(query: string, limit = 15, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  if (!EXA_KEY) return [];

  try {
    const response = await fetch(`${EXA_API}/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        query,
        type: 'auto',
        num_results: limit,
        contents: {
          highlights: { max_characters: 2000 },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      onError?.(`Exa search returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = await response.json() as {
      results?: Array<{
        title: string;
        url: string;
        publishedDate?: string;
        author?: string;
        score?: number;
        highlights?: string[];
        text?: string;
      }>;
    };

    return (data.results ?? [])
      .filter(r => r.title && r.url)
      .map(r => ({
        id: `exa:${r.url}`,
        title: r.title,
        authors: r.author ? [r.author] : [],
        date: r.publishedDate?.slice(0, 10) ?? 'unknown',
        url: r.url,
        sourceApi: 'exa' as const,
        citationCount: 0, // Exa doesn't provide citation counts — rank by score
        abstract: r.highlights?.[0] ?? r.text?.slice(0, 500) ?? undefined,
        type: classifyExaUrl(r.url),
        _exaScore: r.score ?? 0,
      }));
  } catch (e) {
    onError?.(`Exa search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Fetch full content for a known URL via Exa's /contents endpoint.
 * More reliable than Jina for JS-heavy pages — Exa handles rendering.
 */
export async function fetchExaContent(url: string, onError?: (msg: string) => void): Promise<string | null> {
  if (!EXA_KEY) return null;

  try {
    const response = await fetch(`${EXA_API}/contents`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        urls: [url],
        text: { max_characters: 20_000 },
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      onError?.(`Exa content returned ${response.status} for URL ${url}`);
      return null;
    }

    const data = await response.json() as {
      results?: Array<{ text?: string }>;
    };

    return data.results?.[0]?.text ?? null;
  } catch (e) {
    onError?.(`Exa content fetch failed for ${url}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function classifyExaUrl(url: string): DiscoveredSource['type'] {
  if (url.includes('github.com')) return 'repo';
  if (url.includes('reddit.com')) return 'article';
  return 'article';
}
