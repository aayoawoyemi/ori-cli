import type { DiscoveredSource, IngestedSource, ResearchEvent } from './types.js';
import { fetchArxivAbstract, fetchArxivFullText } from './apis/arxiv.js';
import { fetchExaContent } from './apis/exa.js';
import { fetchRedditThread } from './apis/reddit.js';
import { fetchWikipediaArticle } from './apis/wikipedia.js';
import { getReferences } from './apis/semanticScholar.js';
import { scoreSourceQuality } from './quality.js';
import { join } from 'node:path';

/**
 * Phase 2: Deep-read sources. Fetch full content for each source.
 * Papers: abstract + sections (via API or LaTeX).
 * Repos: README + description.
 * Articles: full text via web fetch.
 *
 * If `query` is provided, runs post-fetch quality scoring and drops sources
 * below the minimum threshold. Sources above the drop threshold but below
 * the skim threshold are tagged so extract.ts can reduce their context.
 */
export async function ingestSources(
  sources: DiscoveredSource[],
  fetchFn: (url: string) => Promise<string>,
  query?: string,
  emit?: (e: ResearchEvent) => void,
  relevanceCriteria?: string,
): Promise<IngestedSource[]> {
  // Process in batches of 5 to avoid rate limits
  const results: IngestedSource[] = [];
  const batchSize = 5;

  for (let i = 0; i < sources.length; i += batchSize) {
    const batch = sources.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(source => ingestSingle(source, fetchFn, emit)),
    );
    for (const s of batchResults) {
      if (!s) continue;
      if (query) {
        const q = scoreSourceQuality(s, query, relevanceCriteria);
        s.quality = q;
        if (q.score < 0.15) {
          emit?.({ type: 'ingest_source', title: s.title, sourceApi: s.sourceApi, ok: false, quality: q.score });
          continue;  // drop — too low to be useful
        }
      }
      results.push(s);
    }
  }

  return results;
}

async function ingestSingle(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
  emit?: (e: ResearchEvent) => void,
): Promise<IngestedSource | null> {
  try {
    switch (source.type) {
      case 'paper':
        return await ingestPaper(source, fetchFn, emit);
      case 'repo':
        return await ingestRepo(source, fetchFn, emit);
      case 'article':
        // Reddit threads get native JSON ingestion (richer than page fetch)
        if (source.sourceApi === 'reddit') {
          return await ingestRedditThread(source, emit);
        }
        // Wikipedia uses the extracts API (plain text, no HTML)
        if (source.sourceApi === 'wikipedia') {
          return await ingestWikipediaArticle(source, emit);
        }
        return await ingestArticle(source, fetchFn, emit);
      default:
        return null;
    }
  } catch (e) {
    emit?.({ type: 'error', phase: 'ingest', message: `Failed to ingest "${source.title}": ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

async function ingestPaper(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
  emit?: (e: ResearchEvent) => void,
): Promise<IngestedSource> {
  let abstract = source.abstract ?? '';
  if (!abstract && source.id.startsWith('arxiv:')) {
    try {
      abstract = await fetchArxivAbstract(source.id) ?? '';
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Arxiv abstract fetch failed for ${source.id}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // ArXiv: try PDF first (full text via pdf-parse), fall back to abstract
  // scraped from the landing page via Jina.
  let fullText = abstract;
  if (source.id.startsWith('arxiv:')) {
    try {
      const cacheDir = join(process.cwd(), '.aries', 'arxiv-cache');
      const pdfText = await fetchArxivFullText(source.id, cacheDir);
      if (pdfText && pdfText.length > abstract.length) {
        fullText = pdfText;
      }
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Arxiv full text fetch failed for ${source.id}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // Non-arxiv papers (or arxiv fallback): scrape the landing page
  if (fullText === abstract) {
    try {
      const pageContent = await fetchFn(source.url);
      if (pageContent.length > abstract.length) {
        fullText = pageContent;
      }
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Page fetch failed for ${source.url}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // Fetch references from Semantic Scholar for this paper
  let references: IngestedSource['references'] = [];
  try {
    const s2Id = source.id.startsWith('s2:') ? source.id :
                 source.id.startsWith('arxiv:') ? source.id :
                 source.id.startsWith('doi:') ? source.id : null;
    if (s2Id) {
      const refs = await getReferences(s2Id, 30);
      references = refs.map(r => ({
        title: r.title,
        id: r.id,
        context: undefined,
      }));
    }
  } catch (e) {
    emit?.({ type: 'error', phase: 'ingest', message: `Reference fetch failed for ${source.id}: ${e instanceof Error ? e.message : String(e)}` });
  }

  return {
    ...source,
    sections: [
      { heading: 'Abstract', content: abstract },
      ...(fullText !== abstract ? [{ heading: 'Full Content', content: fullText.slice(0, 20_000) }] : []),
    ],
    references,
    fullText: fullText.slice(0, 30_000),
  };
}

async function ingestRepo(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
  emit?: (e: ResearchEvent) => void,
): Promise<IngestedSource> {
  const readmeUrl = source.url.replace('github.com', 'raw.githubusercontent.com') + '/HEAD/README.md';
  let readme = '';
  try {
    readme = await fetchFn(readmeUrl);
  } catch {
    try {
      readme = await fetchFn(source.url);
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Repo fetch failed for ${source.url}: ${e instanceof Error ? e.message : String(e)}` });
      readme = source.abstract ?? source.title;
    }
  }

  return {
    ...source,
    sections: [{ heading: 'README', content: readme.slice(0, 20_000) }],
    references: [],
    fullText: readme.slice(0, 30_000),
  };
}

async function ingestArticle(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
  emit?: (e: ResearchEvent) => void,
): Promise<IngestedSource> {
  // Try Exa content extraction first (handles JS-rendered pages better than Jina)
  let content = '';
  if (source.sourceApi === 'exa') {
    try {
      content = (await fetchExaContent(source.url)) ?? '';
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Exa content fetch failed for ${source.url}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // Fall back to Jina Reader (the fetchFn passed from the CLI)
  if (!content) {
    try {
      content = await fetchFn(source.url);
    } catch (e) {
      emit?.({ type: 'error', phase: 'ingest', message: `Article fetch failed for ${source.url}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  // Last resort: use the abstract we already have
  if (!content && source.abstract) {
    content = source.abstract;
  }

  return {
    ...source,
    sections: [{ heading: 'Article', content: content.slice(0, 20_000) }],
    references: [],
    fullText: content.slice(0, 30_000),
  };
}

async function ingestWikipediaArticle(source: DiscoveredSource, emit?: (e: ResearchEvent) => void): Promise<IngestedSource> {
  let extract: string;
  try {
    extract = (await fetchWikipediaArticle(source.title)) ?? source.abstract ?? source.title;
  } catch (e) {
    emit?.({ type: 'error', phase: 'ingest', message: `Wikipedia fetch failed for ${source.title}: ${e instanceof Error ? e.message : String(e)}` });
    extract = source.abstract ?? source.title;
  }
  return {
    ...source,
    sections: [{ heading: 'Wikipedia', content: extract.slice(0, 20_000) }],
    references: [],
    fullText: extract.slice(0, 30_000),
  };
}

async function ingestRedditThread(source: DiscoveredSource, emit?: (e: ResearchEvent) => void): Promise<IngestedSource> {
  const urlObj = new URL(source.url);
  const permalink = urlObj.pathname;

  let content: string;
  try {
    content = (await fetchRedditThread(permalink)) ?? source.abstract ?? source.title;
  } catch (e) {
    emit?.({ type: 'error', phase: 'ingest', message: `Reddit thread fetch failed for ${source.url}: ${e instanceof Error ? e.message : String(e)}` });
    content = source.abstract ?? source.title;
  }

  return {
    ...source,
    sections: [{ heading: 'Reddit Thread', content: content.slice(0, 20_000) }],
    references: [],
    fullText: content.slice(0, 30_000),
  };
}
