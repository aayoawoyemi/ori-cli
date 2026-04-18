import type { IngestedSource, QualityScore, ResearchPlan } from './types.js';

/**
 * Post-fetch quality signal. Run after ingest, before extract.
 *
 * Signals combined into a single 0-1 score:
 *   - Text density: alphabetic chars / total chars (penalizes nav/boilerplate)
 *   - Query-term density: how many query keywords per 1000 chars
 *   - Figure count (papers): "Figure N" references are a proxy for real research
 *   - Length plausibility: too short or too long both penalized
 *   - Relevance criteria (from plan): plan-aware keyword matching
 *
 * Gating:
 *   score < 0.15 → drop the source entirely
 *   score < 0.30 → mark as skim (extract with 2K context, cap findings at 3)
 */
export function scoreSourceQuality(source: IngestedSource, query: string, relevanceCriteria?: string): QualityScore {
  const reasons: string[] = [];
  const text = source.fullText || '';
  const len = text.length;

  // Length plausibility — very short is usually a fetch failure or stub,
  // very long past our cap is usually boilerplate.
  let lengthScore: number;
  if (len < 500) {
    lengthScore = 0.1;
    reasons.push('very short text');
  } else if (len < 2000) {
    lengthScore = 0.5;
    reasons.push('short text');
  } else if (len < 30_000) {
    lengthScore = 1.0;
  } else {
    lengthScore = 0.7;
  }

  // Text density — ratio of letters to total chars. Nav-heavy pages have lots
  // of whitespace, symbols, pipes, etc.
  let alpha = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) alpha++;
  }
  const density = len > 0 ? alpha / len : 0;
  const densityScore = Math.min(1, density / 0.55); // 0.55+ is dense prose
  if (densityScore < 0.5) reasons.push('low text density');

  // Query-term density — proxy for "this source is actually about the topic"
  const terms = tokenize(query);
  const loweredText = text.toLowerCase();
  let termHits = 0;
  for (const term of terms) {
    if (term.length < 3) continue;
    const matches = loweredText.split(term).length - 1;
    termHits += matches;
  }
  const per1k = len > 0 ? (termHits * 1000) / len : 0;
  const termScore = Math.min(1, per1k / 1.5); // 1.5+ hits per 1k = strong signal
  if (termScore < 0.3 && terms.length > 0) reasons.push('few query terms');

  // Relevance criteria hits — if a plan provided relevance criteria,
  // extract key terms from it and check for their presence
  let relevanceScore = termScore; // default to query term score
  if (relevanceCriteria) {
    const criteriaTerms = tokenize(relevanceCriteria);
    let criteriaHits = 0;
    for (const term of criteriaTerms) {
      if (term.length < 4) continue;
      const matches = loweredText.split(term).length - 1;
      criteriaHits += matches;
    }
    const criteriaPer1k = len > 0 ? (criteriaHits * 1000) / len : 0;
    const criteriaTermScore = Math.min(1, criteriaPer1k / 1.0);
    // Blend: 60% query terms, 40% relevance criteria terms
    relevanceScore = 0.6 * termScore + 0.4 * criteriaTermScore;
    if (criteriaTermScore < 0.2 && criteriaTerms.length > 2) reasons.push('few relevance criteria terms');
  }

  // Figure count (papers only) — "Figure N" or "Fig. N" patterns
  let figureScore = 0.5;
  if (source.type === 'paper') {
    const figureMatches = text.match(/\b(?:Figure|Fig\.?)\s+\d+/gi) ?? [];
    const figureCount = figureMatches.length;
    if (figureCount >= 4) figureScore = 1.0;
    else if (figureCount >= 1) figureScore = 0.7;
    else {
      figureScore = 0.3;
      reasons.push('no figures in paper');
    }
  }

  // Weighted composite
  const weights = source.type === 'paper'
    ? { length: 0.25, density: 0.25, term: 0.30, figure: 0.20 }
    : { length: 0.30, density: 0.30, term: 0.40, figure: 0.00 };

  const composite =
    weights.length * lengthScore +
    weights.density * densityScore +
    weights.term * relevanceScore +
    weights.figure * figureScore;

  const score = Math.max(0, Math.min(1, composite));
  return {
    score,
    skim: score < 0.30,
    reasons,
  };
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}
