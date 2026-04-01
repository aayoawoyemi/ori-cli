import type { DiscoveredSource } from '../types.js';

/** Search GitHub for repositories matching a query. */
export async function searchGitHub(query: string, limit = 10): Promise<DiscoveredSource[]> {
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
    if (!response.ok) return [];

    const data = await response.json() as {
      items?: Array<{
        full_name: string;
        description?: string;
        html_url: string;
        stargazers_count: number;
        pushed_at?: string;
        language?: string;
        topics?: string[];
      }>;
    };

    return (data.items ?? []).map(repo => ({
      id: `github:${repo.full_name}`,
      title: `${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`,
      authors: [repo.full_name.split('/')[0]],
      date: repo.pushed_at?.slice(0, 10) ?? 'unknown',
      url: repo.html_url,
      sourceApi: 'github' as const,
      citationCount: repo.stargazers_count,
      abstract: repo.description ?? undefined,
      type: 'repo' as const,
    }));
  } catch {
    return [];
  }
}
