import type { DiscoveredSource } from '../types.js';

const REDDIT_API = 'https://www.reddit.com';

/** Search Reddit for posts matching a query. */
export async function searchReddit(query: string, limit = 10, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${REDDIT_API}/search.json?q=${encoded}&sort=relevance&limit=${limit}&type=link`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Aries-CLI/0.1.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      onError?.(`Reddit search returned ${response.status} for query "${query}"`);
      return [];
    }

    const data = await response.json() as {
      data?: {
        children?: Array<{
          data: {
            title: string;
            permalink: string;
            selftext?: string;
            score: number;
            created_utc: number;
            num_comments: number;
            url?: string;
          };
        }>;
      };
    };

    return (data.data?.children ?? []).map(c => ({
      id: `reddit:${c.data.permalink}`,
      title: c.data.title,
      authors: [],
      date: new Date(c.data.created_utc * 1000).toISOString().slice(0, 10),
      url: c.data.url ?? `${REDDIT_API}${c.data.permalink}`,
      sourceApi: 'reddit' as const,
      citationCount: c.data.score, // Use upvotes as citation proxy
      abstract: c.data.selftext?.slice(0, 500) ?? undefined,
      type: 'article' as const,
    }));
  } catch (e) {
    onError?.(`Reddit search failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Fetch a Reddit thread's content (post + top comments) via JSON API. */
export async function fetchRedditThread(permalink: string, onError?: (msg: string) => void): Promise<string | null> {
  const url = `${REDDIT_API}${permalink}.json?limit=20`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Aries-CLI/0.1.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      onError?.(`Reddit thread fetch returned ${response.status} for ${permalink}`);
      return null;
    }

    const data = await response.json() as Array<{
      data?: {
        children?: Array<{
          data: {
            title?: string;
            selftext?: string;
            body?: string;
            score?: number;
            replies?: string | { data?: { children?: Array<{ data: { body?: string; score?: number } }> } };
          };
        }>;
      };
    }>;

    // First listing = post, second = comments
    const post = data[0]?.data?.children?.[0]?.data;
    const comments = data[1]?.data?.children ?? [];

    let content = post?.selftext ?? '';
    for (const c of comments.slice(0, 10)) {
      if (c.data?.body) {
        content += `\n\n---\n**Comment (score: ${c.data.score ?? 0}):**\n${c.data.body}`;
      }
    }

    return content.length > 50 ? content.slice(0, 20_000) : null;
  } catch (e) {
    onError?.(`Reddit thread fetch failed for ${permalink}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
