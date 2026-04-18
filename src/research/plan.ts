import type { ModelRouter } from '../router/index.js';
import type { Budget } from './budget.js';
import type { ResearchPlan } from './types.js';

/**
 * Phase 0: PLAN — LLM-driven research decomposition.
 *
 * Takes a raw query + optional user context, produces a structured research plan:
 *   - Decomposed sub-queries targeted per API
 *   - Active APIs (skip irrelevant ones)
 *   - Relevance criteria for quality scoring
 *   - Estimated depth (how many rounds of deep diving)
 *
 * One cheap LLM call. ~500 tokens in, ~300 tokens out. Cost: negligible.
 */
export async function plan(
  query: string,
  router: ModelRouter,
  budget?: Budget,
  knownContext?: string,
  emit?: (e: import('./types.js').ResearchEvent) => void,
): Promise<ResearchPlan> {
  if (budget && !budget.hasRemaining(3000)) {
    emit?.({ type: 'error', phase: 'plan', message: 'Insufficient budget for plan call' });
    // Fallback: return a basic plan that sends the raw query to all APIs
    return fallbackPlan(query);
  }

  const contextClause = knownContext
    ? `\n\nWhat we already know:\n${knownContext.slice(0, 2000)}`
    : '';

  const prompt = `You are a research strategist. Decompose this research question into targeted sub-queries for structured search APIs.

Research question: "${query}"${contextClause}

Available APIs and their strengths:
- arxiv: Preprints, physics/CS/math/engineering. Use for recent academic work, pre-peer-review.
- semantic_scholar: Peer-reviewed papers across all disciplines. Best for citation-ranked, established work.
- openalex: Broad scholarly works across all fields. Good for cross-disciplinary coverage.
- github: Open-source code, implementations, tools. Use when looking for software or reproducible research.
- exa: Neural web search — blogs, docs, articles, policy papers, industry reports. Best for non-academic or practitioner content.
- reddit: Real-world experience, debate, criticism. Use for practitioner perspectives and unvarnished opinions.
- wikipedia: Reference overviews, terminology anchors, cross-links. Use for background/definitions.

Generate a research plan:
1. Decompose the question into 2-5 sub-queries, each targeted for specific APIs
2. Choose which APIs are relevant (skip ones that won't have useful results)
3. Define what counts as a relevant result (for quality scoring)

Return JSON:
{
  "researchQuestion": "refined version of the question",
  "queries": [
    {"query": "search string", "targetApis": ["api1", "api2"], "rationale": "why", "priority": "essential|supplementary|exploratory"}
  ],
  "activeApis": ["arxiv", "semantic_scholar", ...],
  "relevanceCriteria": "natural language description of what makes a result relevant to this research question",
  "estimatedDepth": 2
}`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content: `Plan research for: "${query}"` },
    ]);
    budget?.estimateAndDeduct(prompt, result);

    const stripped = result.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackPlan(query);

    const parsed = JSON.parse(jsonMatch[0]) as ResearchPlan;

    // Validate: ensure at least one query and activeApis
    if (!parsed.queries?.length || !parsed.activeApis?.length) {
      return fallbackPlan(query);
    }

    // Filter activeApis to only known values
    const validApis = new Set(['arxiv', 'semantic_scholar', 'openalex', 'github', 'exa', 'reddit', 'wikipedia']);
    parsed.activeApis = parsed.activeApis.filter((api: string) => validApis.has(api));
    if (!parsed.activeApis.length) parsed.activeApis = ['semantic_scholar', 'openalex', 'exa'];

    // Filter targetApis in each query
    for (const q of parsed.queries) {
      q.targetApis = q.targetApis.filter((api: string) => validApis.has(api));
      if (!q.targetApis.length) q.targetApis = ['semantic_scholar', 'exa'];
    }

    // Ensure estimatedDepth is reasonable
    if (!parsed.estimatedDepth || parsed.estimatedDepth < 1) parsed.estimatedDepth = 2;
    if (parsed.estimatedDepth > 5) parsed.estimatedDepth = 5;

    return parsed;
  } catch (e) {
    emit?.({ type: 'error', phase: 'plan', message: `Plan generation failed: ${e instanceof Error ? e.message : String(e)}` });
    return fallbackPlan(query);
  }
}

/** Fallback plan when LLM planning fails or budget is exhausted. */
function fallbackPlan(query: string): ResearchPlan {
  return {
    researchQuestion: query,
    queries: [
      { query, targetApis: ['semantic_scholar', 'openalex', 'arxiv'], rationale: 'Broad academic search', priority: 'essential' },
      { query, targetApis: ['exa', 'reddit'], rationale: 'Practitioner and web content', priority: 'supplementary' },
      { query, targetApis: ['wikipedia', 'github'], rationale: 'Background and implementations', priority: 'exploratory' },
    ],
    activeApis: ['semantic_scholar', 'openalex', 'arxiv', 'exa', 'reddit', 'wikipedia', 'github'],
    relevanceCriteria: `Results directly related to "${query}"`,
    estimatedDepth: 2,
  };
}
