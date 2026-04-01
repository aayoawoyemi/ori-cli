import type { DiscoveredSource, CitationNode, CitationEdge } from '../types.js';

const S2_API = 'https://api.semanticscholar.org/graph/v1';
const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY;

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Accept': 'application/json' };
  if (S2_KEY) h['x-api-key'] = S2_KEY;
  return h;
}

/** Search Semantic Scholar for papers. */
export async function searchSemanticScholar(query: string, limit = 20): Promise<DiscoveredSource[]> {
  const encoded = encodeURIComponent(query);
  const url = `${S2_API}/paper/search?query=${encoded}&limit=${limit}&fields=title,authors,year,citationCount,externalIds,abstract,url`;

  try {
    const response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];

    const data = await response.json() as {
      data?: Array<{
        paperId: string;
        title: string;
        authors?: Array<{ name: string }>;
        year?: number;
        citationCount?: number;
        externalIds?: { ArXiv?: string; DOI?: string };
        abstract?: string;
        url?: string;
      }>;
    };

    return (data.data ?? []).map(p => ({
      id: p.externalIds?.DOI ? `doi:${p.externalIds.DOI}` :
          p.externalIds?.ArXiv ? `arxiv:${p.externalIds.ArXiv}` :
          `s2:${p.paperId}`,
      title: p.title,
      authors: p.authors?.map(a => a.name) ?? [],
      date: p.year ? `${p.year}` : 'unknown',
      url: p.url ?? `https://www.semanticscholar.org/paper/${p.paperId}`,
      sourceApi: 'semantic_scholar' as const,
      citationCount: p.citationCount ?? 0,
      abstract: p.abstract ?? undefined,
      type: 'paper' as const,
    }));
  } catch {
    return [];
  }
}

/** Get papers that cite a given paper (citations). */
export async function getCitations(paperId: string, limit = 50): Promise<Array<{ id: string; title: string; citationCount: number }>> {
  const cleanId = paperId.replace(/^(arxiv:|doi:|s2:)/, '');
  const url = `${S2_API}/paper/${cleanId}/citations?fields=title,citationCount&limit=${limit}`;

  try {
    const response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];

    const data = await response.json() as {
      data?: Array<{
        citingPaper: { paperId: string; title: string; citationCount?: number };
      }>;
    };

    return (data.data ?? []).map(d => ({
      id: `s2:${d.citingPaper.paperId}`,
      title: d.citingPaper.title,
      citationCount: d.citingPaper.citationCount ?? 0,
    }));
  } catch {
    return [];
  }
}

/** Get papers referenced by a given paper (references). */
export async function getReferences(paperId: string, limit = 50): Promise<Array<{ id: string; title: string; citationCount: number }>> {
  const cleanId = paperId.replace(/^(arxiv:|doi:|s2:)/, '');
  const url = `${S2_API}/paper/${cleanId}/references?fields=title,citationCount&limit=${limit}`;

  try {
    const response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return [];

    const data = await response.json() as {
      data?: Array<{
        citedPaper: { paperId: string; title: string; citationCount?: number };
      }>;
    };

    return (data.data ?? []).map(d => ({
      id: `s2:${d.citedPaper.paperId}`,
      title: d.citedPaper.title,
      citationCount: d.citedPaper.citationCount ?? 0,
    }));
  } catch {
    return [];
  }
}
