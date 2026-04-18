import type { DiscoveredSource } from '../types.js';

/** Search GitHub for repositories matching a query. */
export async function searchGitHub(query: string, limit = 10, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `https://api.github.com/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=${limit}`;

  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Aries-CLI/0.1.0',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      onError?.(`GitHub search returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = await response.json() as {
      items?: Array<{
        full_name: string;
        description?: string;
        html_url: string;
        stargazers_count: number;
        language?: string;
        topics?: string[];
        pushed_at?: string;
      }>;
    };

    return (data.items ?? []).map(r => ({
      id: `github:${r.full_name}`,
      title: r.full_name,
      authors: [],
      date: r.pushed_at?.slice(0, 10) ?? 'unknown',
      url: r.html_url,
      sourceApi: 'github' as const,
      citationCount: r.stargazers_count, // Use stars as citation proxy for repos
      abstract: r.description ?? undefined,
      type: 'repo' as const,
    }));
  } catch (e) {
    onError?.(`GitHub search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
