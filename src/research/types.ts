// ── Source Types ─────────────────────────────────────────────────────────────

export interface DiscoveredSource {
  id: string;             // DOI, arxiv ID, or URL
  title: string;
  authors: string[];
  date: string;           // YYYY-MM-DD or YYYY
  url: string;
  sourceApi: 'arxiv' | 'semantic_scholar' | 'openalex' | 'github' | 'exa' | 'reddit' | 'wikipedia' | 'web';
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
  quality?: {
    score: number;
    skim: boolean;
    reasons: string[];
  };
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

// ── Read Phase (V3.1) ────────────────────────────────────────────────────────

export interface DeeperTarget {
  targetId: string;
  title: string;
  reason: string;
  urgency: 'critical' | 'interesting' | 'optional';
}

export interface ReadResult {
  findings: Finding[];
  deeperTargets: DeeperTarget[];
  summary: string;
  relevanceAssessment: number;  // 0-1
}

// ── NextAction (V3.1) ───────────────────────────────────────────────────────

export type NextAction =
  | { type: 'search_more'; queries: string[] }
  | { type: 'chase_citations'; targets: string[] }
  | { type: 'deep_dive'; sourceId: string; focus: string }
  | { type: 'done'; reason: string };

// ── Research Plan ───────────────────────────────────────────────────────────

export interface ResearchPlan {
  /** Refined version of the original research question */
  researchQuestion: string;
  /** Decomposed sub-queries, each targeted for specific APIs */
  queries: Array<{
    query: string;
    targetApis: string[];
    rationale: string;
    priority: 'essential' | 'supplementary' | 'exploratory';
  }>;
  /** Which APIs are relevant at all (skip the rest) */
  activeApis: string[];
  /** Natural language description for quality scoring — smarter than keyword overlap */
  relevanceCriteria: string;
  /** What we already know (from builds-on or user context) */
  knownContext?: string;
  /** How many rounds of deep diving are worth doing */
  estimatedDepth: number;
}

// ── Config ──────────────────────────────────────────────────────────────────

export type ResearchDepth = 'quick' | 'standard' | 'deep' | 'exhaustive';

export interface ResearchConfig {
  depth: ResearchDepth;
  maxSources: number;
  chaseDepth: number;         // citation graph hops
  reflectionLoops: number;    // semantic recursion cycles
  tokenBudget: number;        // max tokens (heuristic) spent on router calls
  paginationEnabled: boolean; // fetch page 2 from high-signal APIs
  frontierReEntry: boolean;   // auto-ingest top frontier papers after synthesize
}

export const DEPTH_CONFIGS: Record<ResearchDepth, Omit<ResearchConfig, 'depth'>> = {
  quick:      { maxSources: 15,  chaseDepth: 0, reflectionLoops: 0, tokenBudget:   50_000, paginationEnabled: false, frontierReEntry: false },
  standard:   { maxSources: 30,  chaseDepth: 1, reflectionLoops: 1, tokenBudget:  200_000, paginationEnabled: false, frontierReEntry: true  },
  deep:       { maxSources: 80,  chaseDepth: 2, reflectionLoops: 2, tokenBudget:  800_000, paginationEnabled: true,  frontierReEntry: true  },
  exhaustive: { maxSources: 200, chaseDepth: 3, reflectionLoops: 3, tokenBudget: 3_000_000, paginationEnabled: true,  frontierReEntry: true  },
};

// ── Quality scoring ─────────────────────────────────────────────────────────

export interface QualityScore {
  score: number;  // 0-1
  skim: boolean;  // true → extract with reduced context + finding cap
  reasons: string[];
}

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
  budget?: { max: number; spent: number; remaining: number };
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
  /** Optional event stream for UI rendering. Fires at every phase transition
   *  and incrementally during ingest/extract. Never blocks the pipeline. */
  onEvent?: (e: ResearchEvent) => void;
  /** Abort signal — when triggered, the pipeline stops at the next phase boundary. */
  signal?: AbortSignal;
  /** Research mode: autonomous (engine decides), collaborative (checkpoints for user input). */
  mode?: 'autonomous' | 'collaborative';
  /** In collaborative mode, this callback is invoked at checkpoints.
   *  Returns a promise that resolves when the user has made their choice. */
  onCheckpoint?: (checkpoint: { findings: Finding[]; deeperTargets: DeeperTarget[]; gaps: string[] }) => Promise<NextAction>;
}

// ── Event stream ────────────────────────────────────────────────────────────
// The engine emits these events to drive the UI journal. The pipeline keeps
// working if no listener is attached — onEvent is opt-in.

export type ResearchEvent =
  | { type: 'run_start'; query: string; depth: ResearchDepth; budget: number; apis: string[] }
  | { type: 'plan_start'; query: string }
  | { type: 'plan_done'; plan: ResearchPlan }
  | { type: 'discover_start'; loop: number }
  | { type: 'discover_done'; loop: number; surfaced: number; byApi: Record<string, number> }
  | { type: 'ingest_start'; count: number }
  | { type: 'ingest_source'; title: string; sourceApi: string; ok: boolean; quality?: number }
  | { type: 'ingest_done'; ingested: number; dropped: number; skim: number }
  | { type: 'extract_start' }
  | { type: 'extract_progress'; findingsSoFar: number; sourcesDone: number }
  | { type: 'extract_done'; total: number; primaryCount: number }
  | { type: 'chase_start' }
  | { type: 'chase_done'; sharedCitations: number }
  | { type: 'reflect_start' }
  | { type: 'reflect_done'; followUps: string[] }
  | { type: 'synthesize_start' }
  | { type: 'synthesize_done'; convergent: number; contradictions: number; gaps: number }
  | { type: 'frontier_reentry_start'; count: number }
  | { type: 'frontier_reentry_done'; findings: number }
  | { type: 'budget_update'; spent: number; max: number }
  | { type: 'save_start' }
  | { type: 'save_done'; artifactDir: string; slug: string }
  | { type: 'aborted' }
  | { type: 'error'; phase: string; message: string }
  | { type: 'checkpoint'; findings: Finding[]; deeperTargets: DeeperTarget[]; gaps: string[] };

export interface ResearchResult {
  report: string;             // markdown for display
  session: ResearchSession;
  slug: string;
  artifactDir: string;        // absolute path to saved folder
}
