import type { Message } from '../router/types.js';
import type { ModelRouter } from '../router/index.js';
import { getMessageText } from '../utils/messages.js';

// ── Compaction Classification ───────────────────────────────────────────────
//
// History note (2026-04-29): runPostflight + threshold-triggered reflection
// + session-end auto-reflection + session-metadata vault writes were all
// removed. They were LLM-synthesized "insights" auto-written to the global
// vault on importance thresholds and session exit — usually too generic to
// win retrieval ("be careful with async error handling") or too session-
// specific to reuse ("the indexer was slow because of nested foreign repos").
// They polluted warm-context retrieval and diluted curated notes. Sibling
// feature (agreement-ratio scanning) was killed for the same reason on
// 2026-04-19. extractAndClassifyInsights survives because it only fires
// during user-invoked /compact, classifies by tier (ephemeral|project|vault),
// and the user has an explicit moment to reject the write.

export type InsightTier = 'ephemeral' | 'project' | 'vault';

export interface ExtractedInsight {
  title: string;
  content: string;
  type: string;
  tier: InsightTier;
}

/**
 * Extract and classify insights from conversation during compaction.
 * Uses the cheap model to identify durable knowledge and classify by tier.
 */
export async function extractAndClassifyInsights(
  messages: Message[],
  router: ModelRouter,
): Promise<ExtractedInsight[]> {
  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${getMessageText(m).slice(0, 500)}`)
    .join('\n\n');

  if (conversationText.length < 200) return [];

  const extractionPrompt = `You are extracting durable knowledge from a coding conversation. For each insight, classify it:

- "ephemeral": only matters right now (debugging steps, temporary fixes)
- "project": specific to this codebase (test commands, conventions, architecture decisions for THIS project)
- "vault": universal knowledge that applies across projects (technical patterns, API behaviors, general engineering insights)

Return a JSON array. Each item: {"title": "prose claim as title", "content": "brief explanation", "type": "decision|learning|insight", "tier": "ephemeral|project|vault"}

Only extract genuinely valuable insights. 3-5 items max. Skip ephemeral items — only return project and vault tier.

Conversation:
${conversationText.slice(0, 8000)}`;

  try {
    const result = await router.cheapCall(extractionPrompt, [
      { role: 'user', content: conversationText.slice(0, 8000) },
    ], { maxTokens: 2500 });

    // Parse JSON from the response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const insights = JSON.parse(jsonMatch[0]) as ExtractedInsight[];
    return insights.filter(i => i.title && i.content && i.tier !== 'ephemeral');
  } catch {
    return [];
  }
}
