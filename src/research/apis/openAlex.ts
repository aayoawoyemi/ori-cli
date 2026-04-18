import type { DiscoveredSource } from '../types.js';

const OA_API = 'https://api.openalex.org';

/** Search OpenAlex for scholarly works. Free, no API key needed. `page` supports pagination. */
export async function searchOpenAlex(query: string, limit = 20, page = 1, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${OA_API}/works?search=${encoded}&per_page=${limit}&page=${page}&sort=relevance_score:desc&select=id,title,authorships,publication_year,cited_by_count,doi,primary_location`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Aries-CLI/0.1.0 (mailto:aries@ori-memory.dev)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      onError?.(`OpenAlex search returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = await response.json() as {
      results?: Array<{
        id: string;
        title: string;
        authorships?: Array<{ author: { display_name: string } }>;
        publication_year?: number;
        cited_by_count?: number;
        doi?: string;
        primary_location?: { landing_page_url?: string };
      }>;
    };

    return (data.results ?? [])
      .filter(w => w.title)
      .map(w => ({
        id: w.doi ? `doi:${w.doi.replace('https://doi.org/', '')}` : `openalex:${w.id}`,
        title: w.title,
        authors: w.authorships?.map(a => a.author.display_name) ?? [],
        date: w.publication_year ? `${w.publication_year}` : 'unknown',
        url: w.primary_location?.landing_page_url ?? w.doi ?? w.id,
        sourceApi: 'openalex' as const,
        citationCount: w.cited_by_count ?? 0,
        type: 'paper' as const,
      }));
  } catch (e) {
    onError?.(`OpenAlex search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
