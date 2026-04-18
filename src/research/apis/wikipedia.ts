import type { DiscoveredSource } from '../types.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

/** Search Wikipedia for articles matching a query. */
export async function searchWikipedia(query: string, limit = 10, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encoded}&srlimit=${limit}&format=json`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Aries-CLI/0.1.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      onError?.(`Wikipedia search returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = await response.json() as {
      query?: {
        search?: Array<{
          title: string;
          snippet: string;
          pageid: number;
        }>;
      };
    };

    return (data.query?.search ?? []).map(s => ({
      id: `wiki:${s.title.replace(/ /g, '_')}`,
      title: s.title,
      authors: [],
      date: 'unknown',
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
      sourceApi: 'wikipedia' as const,
      citationCount: 0,
      abstract: s.snippet?.replace(/<[^>]+>/g, '') ?? undefined,
      type: 'article' as const,
    }));
  } catch (e) {
    onError?.(`Wikipedia search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Fetch a Wikipedia article's plain-text extract via the extracts API. */
export async function fetchWikipediaArticle(title: string, onError?: (msg: string) => void): Promise<string | null> {
  const url = `${WIKI_API}?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=0&explaintext=1&format=json`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Aries-CLI/0.1.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      onError?.(`Wikipedia article fetch returned ${response.status} for "${title}"`);
      return null;
    }

    const data = await response.json() as {
      query?: {
        pages?: Record<string, { extract?: string; title?: string }>;
      };
    };

    const pages = data.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0];
    return page?.extract?.slice(0, 20_000) ?? null;
  } catch (e) {
    onError?.(`Wikipedia article fetch failed for "${title}": ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
