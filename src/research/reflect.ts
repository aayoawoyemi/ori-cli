import type { Finding, ResearchEvent, NextAction, ReadResult, ResearchPlan } from './types.js';
import type { ModelRouter } from '../router/index.js';
import type { Budget } from './budget.js';

/**
 * Phase 5 (V3.1): Reflection — the deep research decision point.
 *
 * The LLM reviews findings + deeper targets from the READ phase and decides
 * what to do next. Returns a NextAction union type.
 *
 * Actions:
 *   search_more   — gaps remain, generate new queries
 *   chase_citations — specific references are worth following
 *   deep_dive     — one source deserves a focused re-read
 *   done          — research is comprehensive enough
 */
export async function reflect(
  query: string,
  findings: Finding[],
  router: ModelRouter,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
  plan?: ResearchPlan,
  readResult?: ReadResult,
): Promise<NextAction> {
  if (findings.length < 1) {
    return { type: 'search_more', queries: [query] };
  }
  if (budget && !budget.hasRemaining(2000)) {
    return { type: 'done', reason: 'Budget exhausted' };
  }

  const findingSummary = findings
    .slice(0, 30)
    .map(f => `- [${f.confidence}] ${f.claim} (${f.provenance.sourceTitle})`)
    .join('\n');

  const deeperTargetsClause = readResult?.deeperTargets && readResult.deeperTargets.length > 0
    ? `\n\nPotential targets to chase:\n${readResult.deeperTargets.slice(0, 10).map(t => `- [${t.urgency}] ${t.title}: ${t.reason}`).join('\n')}`
    : '';

  const planClause = plan
    ? `\n\nOriginal research question: "${plan.researchQuestion}"\nRelevance criteria: "${plan.relevanceCriteria}"`
    : `\n\nOriginal research question: "${query}"`;

  const prompt = `You are analyzing research progress and deciding what to do next.

${planClause}

Findings so far (${findings.length} total):
${findingSummary}${deeperTargetsClause}

Based on the findings and gaps:
1. Do we have enough coverage to synthesize? (multiple sources per key aspect)
2. What's still missing? (aspects not covered by any finding)
3. Are there specific references worth chasing? (papers cited but not yet read)
4. Would re-reading a source with a different focus help?

Decide the next action:
- search_more: Generate 2-3 new queries to fill gaps. Use DIFFERENT vocabulary.
- chase_citations: Follow specific references. Provide target IDs.
- deep_dive: Re-read one source with a focused question. Provide source ID and focus.
- done: Research is comprehensive enough to synthesize.

Return JSON:
{
  "type": "search_more" | "chase_citations" | "deep_dive" | "done",
  "queries": ["query1", "query2"],         // for search_more
  "targets": ["targetId1", "targetId2"],  // for chase_citations
  "sourceId": "id", "focus": "question",  // for deep_dive
  "reason": "why this action"              // for done
}`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content: findingSummary },
    ]);
    budget?.estimateAndDeduct(prompt, findingSummary, result);

    const stripped = result.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { type: 'search_more', queries: [query] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      type?: string;
      queries?: string[];
      targets?: string[];
      sourceId?: string;
      focus?: string;
      reason?: string;
    };

    switch (parsed.type) {
      case 'chase_citations':
        return { type: 'chase_citations', targets: parsed.targets ?? [] };
      case 'deep_dive':
        return { type: 'deep_dive', sourceId: parsed.sourceId ?? '', focus: parsed.focus ?? '' };
      case 'done':
        return { type: 'done', reason: parsed.reason ?? 'Sufficient coverage' };
      case 'search_more':
      default:
        return { type: 'search_more', queries: parsed.queries?.length ? parsed.queries : [query] };
    }
  } catch (e) {
    emit?.({ type: 'error', phase: 'reflect', message: `Reflect failed: ${e instanceof Error ? e.message : String(e)}` });
    return { type: 'search_more', queries: [query] };
  }
}

/**
 * Legacy-compatible wrapper: returns string[] for callers that expect the old interface.
 * Used by the V2 pipeline in index.ts when not using the V3.1 recursive loop.
 */
export async function reflectLegacy(
  query: string,
  findings: Finding[],
  router: ModelRouter,
  budget?: Budget,
  emit?: (e: ResearchEvent) => void,
): Promise<string[]> {
  const action = await reflect(query, findings, router, budget, emit);
  if (action.type === 'search_more') return action.queries;
  return [];
}
