import type { DiscoveredSource, ResearchPlan } from './types.js';
import type { Budget } from './budget.js';
import { searchArxiv } from './apis/arxiv.js';
import { searchSemanticScholar } from './apis/semanticScholar.js';
import { searchOpenAlex } from './apis/openAlex.js';
import { searchGitHub } from './apis/github.js';
import { searchExa } from './apis/exa.js';
import { searchReddit } from './apis/reddit.js';
import { searchWikipedia } from './apis/wikipedia.js';

/**
 * Phase 1: Fan-out discovery across structured APIs + web.
 * Parallel searches, deduplicate, rank by citation count × recency.
 *
 * Source tiers:
 *   Tier 1 (academic)     — Arxiv, Semantic Scholar, OpenAlex: citation-ranked, anti-slop
 *   Tier 2 (code)         — GitHub: star-ranked implementations
 *   Tier 2 (reference)    — Wikipedia: overview, anchor terminology, cross-links
 *   Tier 3 (web)          — Exa: blogs, docs, articles, Stack Overflow — neural index
 *   Tier 4 (practitioner) — Reddit: real-world experience, criticism, debate
 */
export interface DiscoverOptions {
  /** Fetch page 2 from tier-1 APIs (arxiv, semantic scholar, openalex) for deeper coverage. */
  paginationEnabled?: boolean;
  /** Token budget — deducts per API call. Stops making calls when exhausted. */
  budget?: Budget;
  /** Callback for emitting error events from discover phase. */
  onError?: (message: string) => void;
}

/** Per-API minimum call intervals (ms). Prevents rate-limit 429s. */
const API_RATE_LIMITS: Record<string, number> = {
  arxiv: 3000,
  semantic_scholar: 1000,
  openalex: 500,
  github: 1000,
  exa: 500,
  reddit: 2000,
  wikipedia: 500,
};

/** Estimated token cost per API call (heuristic for budget tracking). */
const API_CALL_COST = 2000;

/** Track last call time per API for rate limiting. */
const lastCallTime = new Map<string, number>();

/** Enforce minimum interval between calls to the same API. */
async function rateLimit(api: string): Promise<void> {
  const minInterval = API_RATE_LIMITS[api] ?? 1000;
  const now = Date.now();
  const last = lastCallTime.get(api) ?? 0;
  const elapsed = now - last;
  if (elapsed < minInterval) {
    await new Promise(r => setTimeout(r, minInterval - elapsed));
  }
  lastCallTime.set(api, Date.now());
}

// API search functions keyed by name for plan-based routing
const API_SEARCH: Record<string, (query: string, limit: number, onError?: (msg: string) => void) => Promise<DiscoveredSource[]>> = {
  arxiv: (q, l, onError) => rateLimit('arxiv').then(() => searchArxiv(q, l, 0, onError)),
  semantic_scholar: (q, l, onError) => rateLimit('semantic_scholar').then(() => searchSemanticScholar(q, l, 0, onError)),
  openalex: (q, l, onError) => rateLimit('openalex').then(() => searchOpenAlex(q, l, 1, onError)),
  github: (q, l, onError) => rateLimit('github').then(() => searchGitHub(q, l, onError)),
  exa: (q, l, onError) => rateLimit('exa').then(() => searchExa(q, l, onError)),
  reddit: (q, l, onError) => rateLimit('reddit').then(() => searchReddit(q, l, onError)),
  wikipedia: (q, l, onError) => rateLimit('wikipedia').then(() => searchWikipedia(q, l, onError)),
};

/**
 * Plan-based discovery: routes each sub-query to its targeted APIs.
 * Falls back to raw-query-all-APIs when no plan is provided (backward compat).
 */
export async function discover(
  queryOrPlan: string | ResearchPlan,
  maxSources: number,
  seeds?: DiscoveredSource[],
  options: DiscoverOptions = {},
): Promise<DiscoveredSource[]> {
  const { budget, onError } = options;

  // If a ResearchPlan is provided, route sub-queries to targeted APIs
  if (typeof queryOrPlan !== 'string') {
    return discoverFromPlan(queryOrPlan, maxSources, seeds, options);
  }

  // Legacy path: raw query → all APIs
  return discoverRawQuery(queryOrPlan, maxSources, seeds, options);
}

async function discoverFromPlan(
  plan: ResearchPlan,
  maxSources: number,
  seeds: DiscoveredSource[] | undefined,
  options: DiscoverOptions = {},
): Promise<DiscoveredSource[]> {
  const { budget, onError } = options;
  const allRaw: DiscoveredSource[] = [];
  const activeApis = new Set(plan.activeApis);

  // Execute each sub-query against its target APIs
  for (const subQuery of plan.queries) {
    // Only use APIs that are in the plan's activeApis set
    const targetApis = subQuery.targetApis.filter(api => activeApis.has(api));
    if (targetApis.length === 0) continue;

    // Budget check before fan-out
    if (budget && !budget.hasRemaining(API_CALL_COST * targetApis.length)) {
      onError?.(`Budget exhausted before sub-query "${subQuery.query}"`);
      break;
    }

    const results = await Promise.all(
      targetApis.map(async (api) => {
        const searchFn = API_SEARCH[api];
        if (!searchFn) return [];
        try {
          const result = await searchFn(subQuery.query, 15, (msg) => onError?.(msg));
          budget?.deduct(API_CALL_COST);
          return result;
        } catch (e) {
          onError?.(`discover ${api}: ${e instanceof Error ? e.message : String(e)}`);
          return [];
        }
      }),
    );

    for (const batch of results) {
      allRaw.push(...batch);
    }
  }

  // Deduplicate and rank
  return dedupeAndRank(allRaw, seeds, maxSources);
}

async function discoverRawQuery(
  query: string,
  maxSources: number,
  seeds: DiscoveredSource[] | undefined,
  options: DiscoverOptions = {},
): Promise<DiscoveredSource[]> {
  const { budget, onError } = options;

  // Fan-out: 7 parallel API searches with rate limiting + budget gating
  const apiCalls: Array<{ api: string; fn: () => Promise<DiscoveredSource[]> }> = [
    { api: 'arxiv', fn: () => rateLimit('arxiv').then(() => searchArxiv(query, 20)) },
    { api: 'semantic_scholar', fn: () => rateLimit('semantic_scholar').then(() => searchSemanticScholar(query, 20)) },
    { api: 'openalex', fn: () => rateLimit('openalex').then(() => searchOpenAlex(query, 20)) },
    { api: 'github', fn: () => rateLimit('github').then(() => searchGitHub(query, 10)) },
    { api: 'exa', fn: () => rateLimit('exa').then(() => searchExa(query, 15)) },
    { api: 'reddit', fn: () => rateLimit('reddit').then(() => searchReddit(query, 10)) },
    { api: 'wikipedia', fn: () => rateLimit('wikipedia').then(() => searchWikipedia(query, 10)) },
  ];

  const results = await Promise.all(
    apiCalls.map(async ({ api, fn }) => {
      if (budget && !budget.hasRemaining(API_CALL_COST)) {
        return [];
      }
      try {
        const result = await fn();
        budget?.deduct(API_CALL_COST);
        return result;
      } catch (e) {
        onError?.(`discover ${api}: ${e instanceof Error ? e.message : String(e)}`);
        return [];
      }
    }),
  );

  const [arxiv, s2, openAlex, github, exa, reddit, wikipedia] = results;

  // Pagination pass — fetch a second page from the three most productive
  // tier-1 APIs. Deduped later by title, so overlap with page 1 is harmless.
  let arxivP2: DiscoveredSource[] = [];
  let s2P2: DiscoveredSource[] = [];
  let oaP2: DiscoveredSource[] = [];
  if (options.paginationEnabled && (!budget || budget.hasRemaining(API_CALL_COST * 3))) {
    try {
      [arxivP2, s2P2, oaP2] = await Promise.all([
        rateLimit('arxiv').then(() => searchArxiv(query, 20, 20)),
        rateLimit('semantic_scholar').then(() => searchSemanticScholar(query, 20, 20)),
        rateLimit('openalex').then(() => searchOpenAlex(query, 20, 2)),
      ]);
      budget?.deduct(API_CALL_COST * 3);
    } catch (e) {
      onError?.(`discover pagination: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const allRaw = [
    ...s2, ...arxiv, ...openAlex, ...github, ...wikipedia, ...exa, ...reddit,
    ...s2P2, ...arxivP2, ...oaP2,
  ];

  return dedupeAndRank(allRaw, seeds, maxSources);
}

function dedupeAndRank(
  sources: DiscoveredSource[],
  seeds: DiscoveredSource[] | undefined,
  maxSources: number,
): DiscoveredSource[] {
  const seen = new Set<string>();
  const all: DiscoveredSource[] = [];
  const seedIds = new Set((seeds ?? []).map(s => s.id));

  // Seeds from previous session first (frontier sources identified as high-value)
  for (const source of seeds ?? []) {
    const key = normalizeTitle(source.title);
    if (!seen.has(key)) {
      seen.add(key);
      all.push(source);
    }
  }

  // Then fresh API results
  for (const source of sources) {
    const key = normalizeTitle(source.title);
    if (!seen.has(key)) {
      seen.add(key);
      all.push(source);
    }
  }

  // Rank: citation count (log scale) + recency bonus + source tier bonus + seed bonus
  const now = new Date().getFullYear();
  const ranked = all.sort((a, b) => {
    const seedA = seedIds.has(a.id) ? 4 : 0;
    const seedB = seedIds.has(b.id) ? 4 : 0;
    const scoreA = Math.log2((a.citationCount ?? 0) + 1) + recencyBonus(a.date, now) + tierBonus(a.sourceApi) + seedA;
    const scoreB = Math.log2((b.citationCount ?? 0) + 1) + recencyBonus(b.date, now) + tierBonus(b.sourceApi) + seedB;
    return scoreB - scoreA;
  });

  return ranked.slice(0, maxSources);
}

/** Academic sources get a tier bonus — they're citation-ranked and anti-slop. */
function tierBonus(sourceApi: DiscoveredSource['sourceApi']): number {
  switch (sourceApi) {
    case 'semantic_scholar': return 3;
    case 'arxiv':            return 3;
    case 'openalex':         return 2;
    case 'github':           return 2;
    case 'wikipedia':        return 2; // reference/anchor overview for the topic
    case 'exa':              return 1;
    case 'reddit':           return 0; // practitioner signal, not primary source
    default:                 return 0;
  }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

function recencyBonus(date: string, currentYear: number): number {
  const year = parseInt(date.slice(0, 4), 10);
  if (isNaN(year)) return 0;
  const age = currentYear - year;
  if (age <= 1) return 3;
  if (age <= 3) return 2;
  if (age <= 5) return 1;
  return 0;
}
