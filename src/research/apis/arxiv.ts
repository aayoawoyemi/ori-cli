import type { DiscoveredSource } from '../types.js';
import { XMLParser } from 'fast-xml-parser';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ARXIV_API = 'https://export.arxiv.org/api/query';
const JINA_BASE = 'https://r.jina.ai/';

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => name === 'author',
});

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
  links: Array<{ href: string; type?: string }>;
}

/** Search Arxiv for papers matching a query. `start` supports pagination past the first page. */
export async function searchArxiv(query: string, maxResults = 20, start = 0, onError?: (msg: string) => void): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${ARXIV_API}?search_query=all:${encoded}&start=${start}&max_results=${maxResults}&sortBy=relevance&sortOrder=descending`;

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

  try {
    const parsed = xmlParser.parse(xml);
    const feed = parsed?.feed;
    if (!feed) return [];

    const rawEntries = feed.entry;
    if (!rawEntries) return [];

    // Normalize to array (fast-xml-parser returns object for single entries)
    const entryList = Array.isArray(rawEntries) ? rawEntries : [rawEntries];

    for (const entry of entryList) {
      const rawId = entry.id ?? '';
      const id = rawId.replace('http://arxiv.org/abs/', '').replace('https://arxiv.org/abs/', '');
      const title = (entry.title ?? '').replace(/\s+/g, ' ').trim();
      const abstract = (entry.summary ?? '').replace(/\s+/g, ' ').trim();
      const published = (entry.published ?? '').slice(0, 10);

      // Extract authors
      let authors: string[] = [];
      if (entry.author) {
        const authorList = Array.isArray(entry.author) ? entry.author : [entry.author];
        authors = authorList.map((a: any) => (typeof a.name === 'string' ? a.name : (a.name?.['#text'] ?? ''))).map((n: string) => n.trim()).filter(Boolean);
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
  } catch {
    // XML parse failure — return empty rather than crash
  }

  return entries;
}

/** Fetch the abstract for an arxiv paper via the query API. */
export async function fetchArxivAbstract(arxivId: string): Promise<string | null> {
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

/**
 * Fetch the full structured text of an arxiv paper via HTML, not PDF.
 *
 * Why HTML: arxiv ships LaTeX-compiled HTML with full section structure,
 * equations as MathML, figure/table references preserved. That's strictly
 * more signal than any PDF text-extractor (pdf-parse, pdfjs) can give us,
 * and costs nothing extra — Jina Reader handles the HTML → markdown
 * conversion for us.
 *
 * Source chain:
 *   1. arxiv.org/html/<id>            (arxiv's own native HTML, rolling out)
 *   2. ar5iv.labs.arxiv.org/html/<id> (ar5iv — ancient papers, broader coverage)
 *   3. null (caller falls back to abstract)
 *
 * Both HTML sources are fetched through Jina Reader (r.jina.ai) which gives
 * us clean markdown and handles rendered MathML/figures reasonably well.
 */
export async function fetchArxivHtml(arxivId: string, cacheDir?: string): Promise<string | null> {
  const cleanId = arxivId.replace('arxiv:', '');
  const safeId = cleanId.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Cache check
  if (cacheDir) {
    const cachePath = join(cacheDir, `${safeId}.md`);
    if (existsSync(cachePath)) {
      try { return readFileSync(cachePath, 'utf-8'); } catch { /* fall through */ }
    }
  }

  // Try arxiv's native HTML first (newer papers, cleanest markup)
  let content = await fetchViaJina(`https://arxiv.org/html/${cleanId}`);
  // Fall back to ar5iv (older papers, broader coverage, more stable)
  if (!content || content.length < 500) {
    content = await fetchViaJina(`https://ar5iv.labs.arxiv.org/html/${cleanId}`);
  }
  if (!content || content.length < 500) return null;

  // Strip Jina's typical response preamble so it doesn't poison the extractor.
  content = content
    .replace(/^Title:\s*.+?\n+/i, '')
    .replace(/^URL Source:\s*\S+\n+/i, '')
    .replace(/^Markdown Content:\s*\n+/i, '')
    .trim();

  // Cache write
  if (cacheDir) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, `${safeId}.md`), content, 'utf-8');
    } catch { /* cache miss is non-fatal */ }
  }

  return content;
}

async function fetchViaJina(url: string): Promise<string> {
  try {
    const r = await fetch(`${JINA_BASE}${url}`, {
      headers: { Accept: 'text/markdown' },
      signal: AbortSignal.timeout(25_000),
    });
    return r.ok ? await r.text() : '';
  } catch {
    return '';
  }
}

/**
 * Resolve the best-available full text for an arxiv paper.
 * HTML (ar5iv / arxiv.org/html via Jina) → abstract (query API) → null.
 */
export async function fetchArxivFullText(arxivId: string, cacheDir?: string): Promise<string | null> {
  const html = await fetchArxivHtml(arxivId, cacheDir);
  if (html && html.length > 500) return html;
  return await fetchArxivAbstract(arxivId);
}
