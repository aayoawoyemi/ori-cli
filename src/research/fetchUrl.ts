import type { IngestedSource } from './types.js';

/**
 * Targeted URL drill-down for research mode. Replaces WebFetch inside the
 * research namespace — the model picks a URL (usually from a prior
 * research.discover result or a follow-up reference), and this pulls the
 * full content through the same Jina Reader path that ingest.ts uses for
 * articles. Output is a full IngestedSource so the result can be fed into
 * research.extract directly.
 */
export async function fetchUrl(
  url: string,
  fetchFn: (url: string) => Promise<string>,
  opts: { title?: string; focus?: string } = {},
): Promise<IngestedSource> {
  let content = '';
  try {
    content = await fetchFn(url);
  } catch {
    content = '';
  }

  const title = opts.title ?? deriveTitle(url, content);
  const id = `manual:${hash(url)}`;

  return {
    id,
    title,
    authors: [],
    date: new Date().toISOString().slice(0, 10),
    url,
    sourceApi: 'web',
    type: 'article',
    sections: [
      { heading: opts.focus ? `Article (focus: ${opts.focus})` : 'Article', content: content.slice(0, 20_000) },
    ],
    references: [],
    fullText: content.slice(0, 30_000),
  };
}

function deriveTitle(url: string, content: string): string {
  // Prefer the first markdown H1 in the fetched content
  const h1 = content.match(/^#\s+(.+?)\s*$/m);
  if (h1?.[1]) return h1[1].slice(0, 200);
  // Fall back to the last meaningful path segment
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? u.hostname;
    return decodeURIComponent(last).replace(/[-_]/g, ' ').slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

function hash(s: string): string {
  // Small deterministic hash for handle-like IDs (not cryptographic).
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
