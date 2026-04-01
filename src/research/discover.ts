import type { DiscoveredSource } from './types.js';
import { searchArxiv } from './apis/arxiv.js';
import { searchSemanticScholar } from './apis/semanticScholar.js';
import { searchOpenAlex } from './apis/openAlex.js';
import { searchGitHub } from './apis/github.js';

/**
 * Phase 1: Fan-out discovery across structured APIs + web.
 * Parallel searches, deduplicate, rank by citation count × recency.
 */
export async function discover(query: string, maxSources: number): Promise<DiscoveredSource[]> {
  // Fan-out: 4 parallel API searches
  const [arxiv, s2, openAlex, github] = await Promise.all([
    searchArxiv(query, 20),
    searchSemanticScholar(query, 20),
    searchOpenAlex(query, 20),
    searchGitHub(query, 10),
  ]);

  // Deduplicate by normalized title
  const seen = new Set<string>();
  const all: DiscoveredSource[] = [];

  for (const source of [...s2, ...arxiv, ...openAlex, ...github]) {
    const key = normalizeTitle(source.title);
    if (!seen.has(key)) {
      seen.add(key);
      all.push(source);
    }
  }

  // Rank: citation count (log scale) + recency bonus
  const now = new Date().getFullYear();
  const ranked = all.sort((a, b) => {
    const scoreA = Math.log2((a.citationCount ?? 0) + 1) + recencyBonus(a.date, now);
    const scoreB = Math.log2((b.citationCount ?? 0) + 1) + recencyBonus(b.date, now);
    return scoreB - scoreA;
  });

  return ranked.slice(0, maxSources);
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
