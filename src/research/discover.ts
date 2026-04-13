import type { DiscoveredSource } from './types.js';
import { searchArxiv } from './apis/arxiv.js';
import { searchSemanticScholar } from './apis/semanticScholar.js';
import { searchOpenAlex } from './apis/openAlex.js';
import { searchGitHub } from './apis/github.js';
import { searchExa } from './apis/exa.js';
import { searchReddit } from './apis/reddit.js';

/**
 * Phase 1: Fan-out discovery across structured APIs + web.
 * Parallel searches, deduplicate, rank by citation count × recency.
 *
 * Source tiers:
 *   Tier 1 (academic) — Arxiv, Semantic Scholar, OpenAlex: citation-ranked, anti-slop
 *   Tier 2 (code)     — GitHub: star-ranked implementations
 *   Tier 3 (web)      — Exa: blogs, docs, articles, Stack Overflow — neural index
 *   Tier 4 (practitioner) — Reddit: real-world experience, criticism, debate
 */
export async function discover(query: string, maxSources: number, seeds?: DiscoveredSource[]): Promise<DiscoveredSource[]> {
  // Fan-out: 6 parallel API searches
  const [arxiv, s2, openAlex, github, exa, reddit] = await Promise.all([
    searchArxiv(query, 20),
    searchSemanticScholar(query, 20),
    searchOpenAlex(query, 20),
    searchGitHub(query, 10),
    searchExa(query, 15),
    searchReddit(query, 10),
  ]);

  // Deduplicate by normalized title
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
  for (const source of [...s2, ...arxiv, ...openAlex, ...github, ...exa, ...reddit]) {
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
