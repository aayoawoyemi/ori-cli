import type { IngestedSource, Finding } from './types.js';
import type { ModelRouter } from '../router/index.js';

/**
 * Phase 3: Extract findings with provenance from ingested sources.
 * Uses the cheap model for structured extraction.
 */
export async function extractFindings(
  sources: IngestedSource[],
  router: ModelRouter,
): Promise<Finding[]> {
  const allFindings: Finding[] = [];

  // Process sources in batches
  for (const source of sources) {
    const findings = await extractFromSource(source, router);
    allFindings.push(...findings);
  }

  return allFindings;
}

async function extractFromSource(
  source: IngestedSource,
  router: ModelRouter,
): Promise<Finding[]> {
  const content = source.sections
    .map(s => `## ${s.heading}\n${s.content}`)
    .join('\n\n')
    .slice(0, 6000);

  if (content.length < 100) return [];

  const prompt = `Extract key findings from this academic/technical source.

Source: "${source.title}" by ${source.authors.join(', ')} (${source.date})

For each finding, provide:
- claim: a prose statement of the finding (complete sentence)
- type: method | result | claim | definition | limitation | future_work
- confidence: primary (this source's own work), secondary (cites another), hearsay (unattributed)
- evidence: the supporting text (1-2 sentences)

Return JSON array: [{"claim": "...", "type": "...", "confidence": "...", "evidence": "..."}]
Extract 3-8 findings. Focus on methods, results, and key claims.`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content },
    ]);

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
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
  } catch {
    return [];
  }
}
