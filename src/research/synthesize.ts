import type { Finding, SynthesisReport, Convergence, Contradiction, Gap, ResearchDepth, ResearchEvent } from './types.js';
import type { ModelRouter } from '../router/index.js';
import type { Budget } from './budget.js';

/**
 * Phase 6: Cross-source synthesis.
 * Detect convergence, contradictions, and gaps across all findings.
 * Uses the primary model for reasoning quality.
 */
export async function synthesize(
  query: string,
  findings: Finding[],
  depth: ResearchDepth,
  sourcesDiscovered: number,
  sourcesIngested: number,
  chasedDepth: number,
  router: ModelRouter,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
): Promise<SynthesisReport> {
  // Algorithmic synthesis (no LLM needed for basic patterns)
  const convergent = findConvergent(findings);
  const contradictions = findContradictions(findings);

  // LLM synthesis for gaps and deeper patterns
  const gaps = await findGaps(query, findings, router, budget, emit);

  // Frontier: sources referenced in findings but not ingested
  const ingestedIds = new Set(findings.map(f => f.provenance.sourceId));
  const frontier = [...new Set(
    findings
      .filter(f => f.confidence === 'secondary')
      .map(f => f.evidence)
      .filter(e => e.includes('cited') || e.includes('based on'))
  )].slice(0, 10);

  return {
    query,
    depth,
    sourcesDiscovered,
    sourcesIngested,
    findingsExtracted: findings.length,
    citationsChasedDepth: chasedDepth,
    convergent,
    contradictions,
    gaps,
    findings,
    frontier,
  };
}

/** Find claims supported by 2+ independent sources. */
function findConvergent(findings: Finding[]): Convergence[] {
  // Group findings by normalized claim
  const claimGroups = new Map<string, Finding[]>();

  for (const f of findings) {
    const key = f.claim.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 80);
    if (!claimGroups.has(key)) claimGroups.set(key, []);
    claimGroups.get(key)!.push(f);
  }

  // Also check for semantic overlap (simple keyword overlap)
  const convergent: Convergence[] = [];

  for (const [, group] of claimGroups) {
    if (group.length >= 2) {
      const uniqueSources = [...new Set(group.map(f => f.provenance.sourceId))];
      if (uniqueSources.length >= 2) {
        convergent.push({
          claim: group[0].claim,
          supportedBy: uniqueSources,
          confidence: uniqueSources.length,
        });
      }
    }
  }

  return convergent.sort((a, b) => b.confidence - a.confidence);
}

/** Find claims where sources disagree. */
function findContradictions(findings: Finding[]): Contradiction[] {
  // Simple heuristic: look for findings with opposing language
  // about similar topics from different sources
  const contradictions: Contradiction[] = [];

  const negationPairs = [
    ['improves', 'degrades'], ['increases', 'decreases'],
    ['better', 'worse'], ['effective', 'ineffective'],
    ['supports', 'contradicts'], ['confirms', 'refutes'],
  ];

  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (findings[i].provenance.sourceId === findings[j].provenance.sourceId) continue;

      const claimA = findings[i].claim.toLowerCase();
      const claimB = findings[j].claim.toLowerCase();

      // Check for negation pairs
      for (const [pos, neg] of negationPairs) {
        if ((claimA.includes(pos) && claimB.includes(neg)) ||
            (claimA.includes(neg) && claimB.includes(pos))) {
          // Check topical overlap (share 3+ significant words)
          const wordsA = new Set(claimA.split(/\s+/).filter(w => w.length > 4));
          const wordsB = new Set(claimB.split(/\s+/).filter(w => w.length > 4));
          const overlap = [...wordsA].filter(w => wordsB.has(w));

          if (overlap.length >= 2) {
            contradictions.push({
              claim: `${findings[i].claim} vs ${findings[j].claim}`,
              forSources: [findings[i].provenance.sourceId],
              againstSources: [findings[j].provenance.sourceId],
            });
          }
        }
      }
    }
  }

  return contradictions;
}

/** Use LLM to identify gaps in the research. */
async function findGaps(
  query: string,
  findings: Finding[],
  router: ModelRouter,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
): Promise<Gap[]> {
  if (findings.length < 5) return [];
  if (budget && !budget.hasRemaining(2000)) return [];

  const summary = findings
    .slice(0, 20)
    .map(f => `- ${f.claim} [${f.type}, ${f.confidence}]`)
    .join('\n');

  const prompt = `Given the research question "${query}" and these findings:
${summary}

Identify 2-4 important gaps — aspects of the question that NO finding addresses,
or assumptions that all findings make without evidence.

Return JSON array: [{"description": "the gap", "assumedBy": ["source titles that assume this"]}]`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content: summary },
    ]);
    budget?.estimateAndDeduct(prompt, summary, result);
    const stripped = result.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as Gap[];
  } catch (e) {
    emit?.({ type: 'error', phase: 'synthesize', message: `Gap analysis failed: ${e instanceof Error ? e.message : String(e)}` });
    return [];
  }
}
