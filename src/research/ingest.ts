import type { DiscoveredSource, IngestedSource } from './types.js';
import { fetchArxivAbstract } from './apis/arxiv.js';

/**
 * Phase 2: Deep-read sources. Fetch full content for each source.
 * Papers: abstract + sections (via API or LaTeX).
 * Repos: README + description.
 * Articles: full text via web fetch.
 */
export async function ingestSources(
  sources: DiscoveredSource[],
  fetchFn: (url: string) => Promise<string>,
): Promise<IngestedSource[]> {
  // Process in batches of 5 to avoid rate limits
  const results: IngestedSource[] = [];
  const batchSize = 5;

  for (let i = 0; i < sources.length; i += batchSize) {
    const batch = sources.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(source => ingestSingle(source, fetchFn)),
    );
    results.push(...batchResults.filter((r): r is IngestedSource => r !== null));
  }

  return results;
}

async function ingestSingle(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
): Promise<IngestedSource | null> {
  try {
    switch (source.type) {
      case 'paper':
        return await ingestPaper(source, fetchFn);
      case 'repo':
        return await ingestRepo(source, fetchFn);
      case 'article':
        return await ingestArticle(source, fetchFn);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function ingestPaper(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
): Promise<IngestedSource> {
  // Try to get abstract (full LaTeX parsing is V1)
  let abstract = source.abstract ?? '';
  if (!abstract && source.id.startsWith('arxiv:')) {
    abstract = await fetchArxivAbstract(source.id) ?? '';
  }

  // For V0: use abstract as primary content, fetch paper page for more context
  let fullText = abstract;
  try {
    const pageContent = await fetchFn(source.url);
    if (pageContent.length > abstract.length) {
      fullText = pageContent;
    }
  } catch {
    // Use abstract only
  }

  return {
    ...source,
    sections: [
      { heading: 'Abstract', content: abstract },
      ...(fullText !== abstract ? [{ heading: 'Full Content', content: fullText.slice(0, 20_000) }] : []),
    ],
    references: [], // V1: extract from LaTeX \cite{} or Semantic Scholar refs
    fullText: fullText.slice(0, 30_000),
  };
}

async function ingestRepo(
  source: DiscoveredSource,
  fetchFn: (url: string) => Promise<string>,
): Promise<IngestedSource> {
  const readmeUrl = source.url.replace('github.com', 'raw.githubusercontent.com') + '/HEAD/README.md';
  let readme = '';
  try {
    readme = await fetchFn(readmeUrl);
  } catch {
    try {
      readme = await fetchFn(source.url);
    } catch {
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
): Promise<IngestedSource> {
  const content = await fetchFn(source.url);

  return {
    ...source,
    sections: [{ heading: 'Article', content: content.slice(0, 20_000) }],
    references: [],
    fullText: content.slice(0, 30_000),
  };
}
