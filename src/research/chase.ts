import type { DiscoveredSource, CitationGraph, CitationNode, CitationEdge } from './types.js';
import { getCitations, getReferences } from './apis/semanticScholar.js';

/**
 * Phase 4: Citation graph traversal.
 * Follow references and citations to find convergent sources —
 * papers cited by 2+ of our sources are high signal.
 */
export async function chaseCitations(
  sources: DiscoveredSource[],
  depth: number,
): Promise<{ graph: CitationGraph; sharedCitations: DiscoveredSource[] }> {
  const graph: CitationGraph = {
    nodes: new Map(),
    edges: [],
  };

  if (depth === 0) {
    return { graph, sharedCitations: [] };
  }

  // Track which papers are cited by multiple of our sources
  const citedBy = new Map<string, Set<string>>(); // paperId → set of our source IDs

  // Get references for top 5 sources (most cited first)
  const topSources = [...sources]
    .sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
    .slice(0, 5);

  for (const source of topSources) {
    // Add source to graph
    graph.nodes.set(source.id, {
      id: source.id,
      title: source.title,
      citationCount: source.citationCount ?? 0,
      inDegree: 0,
      depth: 0,
    });

    // Get references (what this paper cites)
    const refs = await getReferences(source.id, 30);

    for (const ref of refs) {
      // Track edge
      graph.edges.push({ from: source.id, to: ref.id });

      // Track who cites this
      if (!citedBy.has(ref.id)) citedBy.set(ref.id, new Set());
      citedBy.get(ref.id)!.add(source.id);

      // Add to graph
      if (!graph.nodes.has(ref.id)) {
        graph.nodes.set(ref.id, {
          id: ref.id,
          title: ref.title,
          citationCount: ref.citationCount,
          inDegree: 1,
          depth: 1,
        });
      } else {
        const node = graph.nodes.get(ref.id)!;
        node.inDegree++;
      }
    }

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  // Find shared citations — cited by 2+ of our sources = convergent evidence
  const shared: DiscoveredSource[] = [];
  for (const [paperId, citers] of citedBy) {
    if (citers.size >= 2) {
      const node = graph.nodes.get(paperId);
      if (node) {
        shared.push({
          id: paperId,
          title: node.title,
          authors: [],
          date: 'unknown',
          url: `https://www.semanticscholar.org/paper/${paperId.replace('s2:', '')}`,
          sourceApi: 'semantic_scholar',
          citationCount: node.citationCount,
          type: 'paper',
        });
      }
    }
  }

  // Sort shared by number of citers (most convergent first)
  shared.sort((a, b) => {
    const aCount = citedBy.get(a.id)?.size ?? 0;
    const bCount = citedBy.get(b.id)?.size ?? 0;
    return bCount - aCount;
  });

  return { graph, sharedCitations: shared };
}
