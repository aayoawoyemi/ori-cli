import type { DiscoveredSource } from '../types.js';

const ARXIV_API = 'https://export.arxiv.org/api/query';

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
  links: Array<{ href: string; type?: string }>;
}

/** Search Arxiv for papers matching a query. */
export async function searchArxiv(query: string, maxResults = 20): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${ARXIV_API}?search_query=all:${encoded}&start=0&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return [];

    const xml = await response.text();
    return parseArxivXml(xml);
  } catch {
    return [];
  }
}

function parseArxivXml(xml: string): DiscoveredSource[] {
  const entries: DiscoveredSource[] = [];

  // Simple XML parsing — extract <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const id = extractTag(entry, 'id')?.replace('http://arxiv.org/abs/', '') ?? '';
    const title = extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim() ?? '';
    const abstract = extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim() ?? '';
    const published = extractTag(entry, 'published')?.slice(0, 10) ?? '';

    // Extract authors
    const authors: string[] = [];
    const authorRegex = /<author>\s*<name>(.*?)<\/name>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    if (id && title) {
      entries.push({
        id: `arxiv:${id}`,
        title,
        authors,
        date: published,
        url: `https://arxiv.org/abs/${id}`,
        sourceApi: 'arxiv',
        abstract,
        type: 'paper',
      });
    }
  }

  return entries;
}

function extractTag(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const match = regex.exec(xml);
  return match ? match[1] : null;
}

/** Fetch the LaTeX source for an arxiv paper (tar.gz → extract .tex files). */
export async function fetchArxivAbstract(arxivId: string): Promise<string | null> {
  // For V0, we use the abstract from the API response.
  // Full LaTeX source fetching (arxiv.org/src/{id}) is V1.
  try {
    const cleanId = arxivId.replace('arxiv:', '');
    const url = `${ARXIV_API}?id_list=${cleanId}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;

    const xml = await response.text();
    const entries = parseArxivXml(xml);
    return entries[0]?.abstract ?? null;
  } catch {
    return null;
  }
}
