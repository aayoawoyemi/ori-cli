import type { DiscoveredSource } from '../types.js';

const REDDIT_API = 'https://www.reddit.com';

/**
 * Search Reddit using the free JSON API (no auth required).
 * Returns top posts + first 500 chars of selftext as abstract.
 * Targets subreddits relevant to the query when possible.
 */
export async function searchReddit(query: string, limit = 10): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${REDDIT_API}/search.json?q=${encoded}&sort=relevance&limit=${limit}&type=link,self&t=year`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Aries-Research/0.1.0 (research engine; non-commercial)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return [];

    const data = await response.json() as {
      data?: {
        children?: Array<{
          data: {
            id: string;
            title: string;
            selftext?: string;
            url: string;
            permalink: string;
            subreddit: string;
            author: string;
            created_utc: number;
            score: number;
            num_comments: number;
          };
        }>;
      };
    };

    return (data.data?.children ?? [])
      .filter(c => c.data.title && c.data.score > 5)
      .map(c => {
        const post = c.data;
        const date = new Date(post.created_utc * 1000).toISOString().slice(0, 10);
        const abstract = post.selftext
          ? post.selftext.slice(0, 500).replace(/\n+/g, ' ')
          : `r/${post.subreddit} — ${post.num_comments} comments, ${post.score} upvotes`;

        return {
          id: `reddit:${post.id}`,
          title: post.title,
          authors: [`u/${post.author}`],
          date,
          url: `https://www.reddit.com${post.permalink}`,
          sourceApi: 'reddit' as const,
          citationCount: post.score, // upvotes as proxy for relevance
          abstract,
          type: 'article' as const,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Fetch a Reddit thread as structured text: title + body + top comments.
 * Returns LLM-ready markdown. Much richer than a raw page fetch.
 */
export async function fetchRedditThread(permalink: string): Promise<string | null> {
  // Strip trailing slash, append .json
  const cleanPath = permalink.replace(/\/$/, '');
  const url = `https://www.reddit.com${cleanPath}.json?limit=20&sort=top`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Aries-Research/0.1.0 (research engine; non-commercial)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as Array<{
      data: {
        children: Array<{
          data: {
            title?: string;
            selftext?: string;
            body?: string;
            author: string;
            score: number;
            replies?: { data?: { children?: Array<{ data: { body?: string; author: string; score: number } }> } };
          };
        }>;
      };
    }>;

    const lines: string[] = [];

    // Post body
    const post = data[0]?.data?.children?.[0]?.data;
    if (post) {
      if (post.title) lines.push(`# ${post.title}\n`);
      if (post.selftext) lines.push(`${post.selftext}\n`);
    }

    // Top comments
    const comments = data[1]?.data?.children ?? [];
    const topComments = comments
      .filter(c => c.data.body && c.data.score > 3)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, 10);

    if (topComments.length > 0) {
      lines.push('\n## Top Comments\n');
      for (const c of topComments) {
        lines.push(`**u/${c.data.author}** (${c.data.score} pts): ${c.data.body}\n`);
      }
    }

    return lines.join('\n') || null;
  } catch {
    return null;
  }
}
