import type { IngestedSource, Finding, QualityScore, ResearchEvent } from './types.js';
import type { ModelRouter } from '../router/index.js';
import type { Budget } from './budget.js';

export interface ExtractOptions {
  focus?: string;
  budget?: Budget;
  quality?: QualityScore;
  onError?: (message: string) => void;
}

/**
 * Phase 3: Extract findings with provenance from ingested sources.
 * Uses the cheap model for structured extraction.
 */
export async function extractFindings(
  sources: IngestedSource[],
  router: ModelRouter,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
): Promise<Finding[]> {
  const allFindings: Finding[] = [];

  // Process sources in batches
  for (const source of sources) {
    if (budget && !budget.hasRemaining(2000)) break; // reserve headroom for response
    const findings = await extractFromSource(source, router, {
      budget,
      quality: source.quality,
      onError: (msg) => emit?.({ type: 'error', phase: 'extract', message: msg }),
    });
    allFindings.push(...findings);
  }

  return allFindings;
}

export async function extractFromSource(
  source: IngestedSource,
  router: ModelRouter,
  optsOrFocus?: ExtractOptions | string,
): Promise<Finding[]> {
  // Back-compat: older callers pass a string `focus` as third arg.
  const opts: ExtractOptions = typeof optsOrFocus === 'string'
    ? { focus: optsOrFocus }
    : (optsOrFocus ?? {});
  const { focus, budget, quality, onError } = opts;

  if (budget && !budget.hasRemaining(2000)) return [];

  const skim = quality?.skim === true;
  const contextCap = skim ? 2000 : 6000;
  const findingCapClause = skim ? 'Extract 1-3 findings only (low-quality source; skim mode).' : 'Extract 3-8 findings. Focus on methods, results, and key claims.';

  const content = source.sections
    .map(s => `## ${s.heading}\n${s.content}`)
    .join('\n\n')
    .slice(0, contextCap);

  if (content.length < 100) return [];

  const focusClause = focus ? `\n\nFocus particularly on: ${focus}` : '';

  const prompt = `Extract key findings from this academic/technical source.

Source: "${source.title}" by ${source.authors.join(', ')} (${source.date})

For each finding, provide:
- claim: a prose statement of the finding (complete sentence)
- type: method | result | claim | definition | limitation | future_work
- confidence: primary (this source's own work), secondary (cites another), hearsay (unattributed)
- evidence: the supporting text (1-2 sentences)

Return JSON array: [{"claim": "...", "type": "...", "confidence": "...", "evidence": "..."}]
${findingCapClause}${focusClause}`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content },
    ]);
    budget?.estimateAndDeduct(prompt, content, result);

    // Strip markdown code fences, then greedy-match the outermost JSON array.
    // Non-greedy would truncate at the first ] inside a string value.
    const stripped = result.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      claim: string; type: string; confidence: string; evidence: string;
    }>;

    return parsed
      .filter(f => f.claim && f.evidence)
      .map(f => ({
        claim: f.claim,
        evidence: f.evidence,
        provenance: {
          sourceId: source.id,
          sourceTitle: source.title,
          url: source.url,
        },
        type: (f.type as Finding['type']) || 'claim',
        confidence: (f.confidence as Finding['confidence']) || 'secondary',
      }));
  } catch (e) {
    onError?.(`Extract failed for "${source.title}": ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
