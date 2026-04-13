// ── Source Types ─────────────────────────────────────────────────────────────

export interface DiscoveredSource {
  id: string;             // DOI, arxiv ID, or URL
  title: string;
  authors: string[];
  date: string;           // YYYY-MM-DD or YYYY
  url: string;
  sourceApi: 'arxiv' | 'semantic_scholar' | 'openalex' | 'github' | 'exa' | 'reddit' | 'web';
  citationCount?: number;
  abstract?: string;
  type: 'paper' | 'repo' | 'article';
}

export interface IngestedSource extends DiscoveredSource {
  sections: Array<{
    heading: string;
    content: string;
  }>;
  references: Array<{
    title: string;
    id?: string;          // DOI or arxiv ID
    context?: string;     // the citation sentence
  }>;
  fullText: string;
}

// ── Findings ────────────────────────────────────────────────────────────────

export interface Finding {
  claim: string;          // prose-as-title
  evidence: string;       // supporting text
  provenance: {
    sourceId: string;
    sourceTitle: string;
    section?: string;
    url: string;
  };
  type: 'method' | 'result' | 'claim' | 'definition' | 'limitation' | 'future_work';
  confidence: 'primary' | 'secondary' | 'hearsay';
}

// ── Citation Graph ──────────────────────────────────────────────────────────

export interface CitationNode {
  id: string;
  title: string;
  citationCount: number;
  inDegree: number;       // how many of OUR sources cite this
  depth: number;          // hops from original query
}

export interface CitationEdge {
  from: string;           // source ID
  to: string;             // cited paper ID
  context?: string;
}

export interface CitationGraph {
  nodes: Map<string, CitationNode>;
  edges: CitationEdge[];
}

// ── Synthesis ───────────────────────────────────────────────────────────────

export interface Convergence {
  claim: string;
  supportedBy: string[];  // source IDs
  confidence: number;     // number of supporting sources
}

export interface Contradiction {
  claim: string;
  forSources: string[];
  againstSources: string[];
}

export interface Gap {
  description: string;
  assumedBy: string[];
}

export interface SynthesisReport {
  query: string;
  depth: ResearchDepth;
  sourcesDiscovered: number;
  sourcesIngested: number;
  findingsExtracted: number;
  citationsChasedDepth: number;
  convergent: Convergence[];
  contradictions: Contradiction[];
  gaps: Gap[];
  findings: Finding[];
  frontier: string[];     // cited but not ingested (next targets)
}

// ── Config ──────────────────────────────────────────────────────────────────

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive';

export interface ResearchConfig {
  depth: ResearchDepth;
  maxSources: number;
  chaseDepth: number;       // citation graph hops
  reflectionLoops: number;  // semantic recursion cycles
}

export const DEPTH_CONFIGS: Record<ResearchDepth, Omit<ResearchConfig, 'depth'>> = {
  quick:      { maxSources: 15,  chaseDepth: 0, reflectionLoops: 0 },
  standard:   { maxSources: 30,  chaseDepth: 1, reflectionLoops: 1 },
  deep:       { maxSources: 80,  chaseDepth: 2, reflectionLoops: 2 },
  exhaustive: { maxSources: 200, chaseDepth: 3, reflectionLoops: 3 },
};

// ── Session Artifacts ───────────────────────────────────────────────────────

export interface SessionMeta {
  slug: string;
  query: string;
  depth: ResearchDepth;
  date: string;               // ISO 8601
  sourcesDiscovered: number;
  sourcesIngested: number;
  findingsCount: number;
  convergentCount: number;
  contradictionCount: number;
  gapCount: number;
  buildsOn?: string;          // slug of parent session
}

export interface ResearchSession {
  meta: SessionMeta;
  report: SynthesisReport;
  sources: DiscoveredSource[];
  findings: Finding[];
  graph: { nodes: Array<CitationNode & { id: string }>; edges: CitationEdge[] };
  frontier: string[];         // source IDs cited but not ingested
  reflectionQueries: string[];
}

export interface ResearchOptions {
  fetchFn: (url: string) => Promise<string>;
  outputDir: string;
  buildsOn?: string;
}

export interface ResearchResult {
  report: string;             // markdown for display
  session: ResearchSession;
  slug: string;
  artifactDir: string;        // absolute path to saved folder
}
