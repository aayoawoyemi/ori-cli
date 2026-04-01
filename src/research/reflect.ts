import type { Finding } from './types.js';
import type { ModelRouter } from '../router/index.js';

/**
 * Phase 5: Reflection — IterDRAG pattern.
 * Review findings so far, identify gaps, generate follow-up queries.
 * This is the semantic recursion that makes research deep, not just wide.
 */
export async function reflect(
  query: string,
  findings: Finding[],
  router: ModelRouter,
): Promise<string[]> {
  if (findings.length < 3) return []; // not enough data to reflect

  const findingSummary = findings
    .slice(0, 30)
    .map(f => `- [${f.confidence}] ${f.claim} (${f.provenance.sourceTitle})`)
    .join('\n');

  const prompt = `You are analyzing research findings to identify gaps and generate follow-up queries.

Original research question: "${query}"

Findings so far (${findings.length} total):
${findingSummary}

Based on these findings:
1. What do we know well? (areas with multiple supporting sources)
2. What's missing? (aspects of the question not covered by any finding)
3. What contradictions exist? (conflicting claims)
4. What would we need to search for to fill the gaps?

Generate 2-3 follow-up search queries that would fill the most important gaps.
These should use DIFFERENT vocabulary than the original query to find new sources.

Return JSON: {"gaps": ["gap1", "gap2"], "followUpQueries": ["query1", "query2", "query3"]}`;

  try {
    const result = await router.cheapCall(prompt, [
      { role: 'user', content: findingSummary },
    ]);

    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as {
      gaps?: string[];
      followUpQueries?: string[];
    };

    return parsed.followUpQueries ?? [];
  } catch {
    return [];
  }
}
