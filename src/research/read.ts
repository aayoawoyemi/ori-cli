import type { IngestedSource, Finding, ReadResult, DeeperTarget, ResearchPlan, ResearchEvent } from './types.js';
import type { ModelRouter } from '../router/index.js';
import type { Budget } from './budget.js';

/**
 * Phase 3 (V3.1): READ — LLM reads source with plan context.
 *
 * Key difference from V2 extract: READ is a judgment call, not a pure function.
 * The LLM has the research plan in context, knows what we've already found,
 * and decides whether this source is a dead end or a gold mine.
 *
 * Returns:
 *   - findings: structured claims with provenance
 *   - deeperTargets: things worth chasing (cited papers, references)
 *   - summary: 2-3 sentence human-readable contribution summary
 *   - relevanceAssessment: 0-1 how relevant to our research question
 */
export async function readSource(
  source: IngestedSource,
  router: ModelRouter,
  plan: ResearchPlan,
  budget?: Budget,
  existingFindings?: Finding[],
  emit?: (e: ResearchEvent) => void,
): Promise<ReadResult> {
  if (budget && !budget.hasRemaining(3000)) {
    return { findings: [], deeperTargets: [], summary: 'Budget exhausted', relevanceAssessment: 0 };
  }

  const skim = source.quality?.skim === true;
  const contextCap = skim ? 2000 : 8000;

  const content = source.sections
    .map(s => `## ${s.heading}\n${s.content}`)
    .join('\n\n')
    .slice(0, contextCap);

  if (content.length < 100) {
    return { findings: [], deeperTargets: [], summary: 'Source too short to read', relevanceAssessment: 0 };
  }

  // Build context about what we already know
  const existingContext = existingFindings && existingFindings.length > 0
    ? `\n\nWhat we already know (${existingFindings.length} findings so far):\n` +
      existingFindings.slice(0, 15).map(f => `- ${f.claim}`).join('\n')
    : '';

  // References from the source (if available from ingest)
  const refsClause = source.references && source.references.length > 0
    ? `\n\nThis source references:\n${source.references.slice(0, 15).map(r => `- ${r.title}${r.id ? ` (${r.id})` : ''}`).join('\n')}`
    : '';

  const prompt = `You are a research analyst reading a source in the context of a structured research plan.

Research question: "${plan.researchQuestion}"
Relevance criteria: "${plan.relevanceCriteria}"

Source: "${source.title}" by ${source.authors.join(', ')} (${source.date})
${existingContext}${refsClause}

Read this source and provide:

1. **Findings**: Extract key claims, methods, results, limitations. Each finding needs:
   - claim: complete sentence stating the finding
   - type: method | result | claim | definition | limitation | future_work
   - confidence: primary (this source's own work), secondary (cites another), hearsay (unattributed)
   - evidence: 1-2 sentences of supporting text

2. **Deeper targets**: What should we chase next? References or cited works that seem critical to our research question. For each:
   - targetId: the paper/source ID (DOI, arxiv ID, S2 ID, or URL)
   - title: the title
   - reason: why this is worth chasing (1 sentence)
   - urgency: critical | interesting | optional

3. **Summary**: 2-3 sentences describing what this source contributes to our research.

4. **Relevance**: Rate 0-1 how relevant this source is to our research question.

${skim ? 'This is a low-quality source (skim mode): Extract 1-3 findings only.' : 'Extract 3-8 findings. Focus on what advances our research question.'}

Return JSON:
{
  "findings": [{"claim": "...", "type": "...", "confidence": "...", "evidence": "..."}],
  "deeperTargets": [{"targetId": "...", "title": "...", "reason": "...", "urgency": "..."}],
  "summary": "...",
  "relevanceAssessment": 0.0
}`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content },
    ]);
    budget?.estimateAndDeduct(prompt, content, result);

    const stripped = result.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { findings: [], deeperTargets: [], summary: 'No structured output from LLM', relevanceAssessment: 0 };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      findings?: Array<{ claim: string; type: string; confidence: string; evidence: string }>;
      deeperTargets?: Array<{ targetId: string; title: string; reason: string; urgency: string }>;
      summary?: string;
      relevanceAssessment?: number;
    };

    const findings: Finding[] = (parsed.findings ?? [])
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

    const deeperTargets: DeeperTarget[] = (parsed.deeperTargets ?? [])
      .filter(d => d.targetId && d.title)
      .map(d => ({
        targetId: d.targetId,
        title: d.title,
        reason: d.reason ?? '',
        urgency: (d.urgency as DeeperTarget['urgency']) || 'optional',
      }));

    return {
      findings,
      deeperTargets,
      summary: parsed.summary ?? '',
      relevanceAssessment: Math.max(0, Math.min(1, parsed.relevanceAssessment ?? 0.5)),
    };
  } catch (e) {
    emit?.({ type: 'error', phase: 'read', message: `Read failed for "${source.title}": ${e instanceof Error ? e.message : String(e)}` });
    return { findings: [], deeperTargets: [], summary: `Read error: ${e instanceof Error ? e.message : String(e)}`, relevanceAssessment: 0 };
  }
}

/**
 * Read multiple sources in sequence (with budget awareness).
 * Returns aggregated ReadResult.
 */
export async function readSources(
  sources: IngestedSource[],
  router: ModelRouter,
  plan: ResearchPlan,
  budget?: Budget,
  existingFindings?: Finding[],
  emit?: (e: ResearchEvent) => void,
): Promise<ReadResult> {
  const allFindings: Finding[] = [];
  const allDeeperTargets: DeeperTarget[] = [];
  const summaries: string[] = [];
  let totalRelevance = 0;

  for (const source of sources) {
    if (budget && !budget.hasRemaining(3000)) break;
    const result = await readSource(source, router, plan, budget, existingFindings, emit);
    allFindings.push(...result.findings);
    allDeeperTargets.push(...result.deeperTargets);
    if (result.summary) summaries.push(`[${source.title}]: ${result.summary}`);
    totalRelevance += result.relevanceAssessment;
  }

  return {
    findings: allFindings,
    deeperTargets: allDeeperTargets,
    summary: summaries.join('\n'),
    relevanceAssessment: sources.length > 0 ? totalRelevance / sources.length : 0,
  };
}
