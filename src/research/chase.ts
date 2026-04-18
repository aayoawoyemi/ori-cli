import type { DiscoveredSource, CitationGraph, CitationNode, CitationEdge, ResearchEvent } from './types.js';
import type { Budget } from './budget.js';
import { getReferences } from './apis/semanticScholar.js';

/** Estimated token cost per S2 API call for budget tracking. */
const S2_CALL_COST = 1000;

/**
 * Phase 4: Citation graph traversal with multi-hop depth.
 * Follow references recursively to find convergent sources —
 * papers cited by 2+ of our sources are high signal.
 *
 * `depth` controls how many hops to chase:
 *   depth 1: references of top sources
 *   depth 2: references of references
 *   depth 3: three hops out
 */
export async function chaseCitations(
  sources: DiscoveredSource[],
  depth: number,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
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

  // Seed the frontier with our top sources at depth 0
  const frontier: Array<{ id: string; depth: number }> = topSources.map(s => ({ id: s.id, depth: 0 }));

  // Add our top sources to the graph
  for (const source of topSources) {
    graph.nodes.set(source.id, {
      id: source.id,
      title: source.title,
      citationCount: source.citationCount ?? 0,
      inDegree: 0,
      depth: 0,
    });
  }

  // Multi-hop BFS: chase references up to `depth` hops
  const visited = new Set<string>();

  while (frontier.length > 0) {
    const current = frontier.shift()!;
    if (current.depth >= depth) continue;
    if (visited.has(current.id)) continue;
    visited.add(current.id);

    // Budget check before each S2 call
    if (budget && !budget.hasRemaining(S2_CALL_COST)) {
      emit?.({ type: 'error', phase: 'chase', message: `Budget exhausted during citation chase at depth ${current.depth}` });
      break;
    }

    let refs: Array<{ id: string; title: string; citationCount: number }>;
    try {
      refs = await getReferences(current.id, 30);
      budget?.deduct(S2_CALL_COST);
    } catch (e) {
      emit?.({ type: 'error', phase: 'chase', message: `getReferences failed for ${current.id}: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    for (const ref of refs) {
      // Track edge
      graph.edges.push({ from: current.id, to: ref.id });

      // Track who cites this
      if (!citedBy.has(ref.id)) citedBy.set(ref.id, new Set());
      // Only count in-degree from our original top sources (depth 0)
      if (current.depth === 0) {
        citedBy.get(ref.id)!.add(current.id);
      }

      // Add to graph
      if (!graph.nodes.has(ref.id)) {
        graph.nodes.set(ref.id, {
          id: ref.id,
          title: ref.title,
          citationCount: ref.citationCount,
          inDegree: 1,
          depth: current.depth + 1,
        });
        // Add to frontier for next hop
        frontier.push({ id: ref.id, depth: current.depth + 1 });
      } else {
        const node = graph.nodes.get(ref.id)!;
        if (current.depth === 0) {
          node.inDegree++;
        }
        // Update depth if we reached this node via a shorter path
        if (current.depth + 1 < node.depth) {
          node.depth = current.depth + 1;
        }
      }
    }

    // Minimum 1s delay between S2 API calls
    await new Promise(r => setTimeout(r, 1000));
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
