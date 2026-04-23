import type { Message } from '../router/types.js';
import type { OriVault } from './vault.js';
import type { ProjectBrain } from './projectBrain.js';
import type { ModelRouter } from '../router/index.js';
import { triggerReflectionWithModel, triggerReflectionSimple } from './reflection.js';
import { getMessageText } from '../utils/messages.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const REFLECTION_THRESHOLD = 150;

// ── Postflight Engine ───────────────────────────────────────────────────────

/**
 * Run after a tool-using turn completes (gated by caller).
 *
 * 1. Accumulate importance (tool-using turns score 3, otherwise 1)
 * 2. Trigger reflection if accumulator crosses REFLECTION_THRESHOLD
 *
 * Agreement-ratio scanning removed 2026-04-19 — keyword slop that wrote
 * to vault on every threshold crossing. The no-sycophancy rule lives in
 * the system prompt instead.
 *
 * Returns the new importance accumulator value.
 */
export async function runPostflight(
  messages: Message[],
  _projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  currentImportance: number,
  router?: ModelRouter,
): Promise<number> {
  const recentMessages = messages.slice(-5);
  const hadToolCalls = recentMessages.some(m => {
    if (typeof m.content === 'string') return false;
    return m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result');
  });

  const importance = hadToolCalls ? 3 : 1;
  const newAccumulator = currentImportance + importance;

  // ── Reflection trigger ──────────────────────────────────────────────
  if (vault?.connected && newAccumulator >= REFLECTION_THRESHOLD) {
    if (router) {
      triggerReflectionWithModel(messages, vault, router).catch(() => {
        triggerReflectionSimple(messages, vault).catch(() => {});
      });
    } else {
      triggerReflectionSimple(messages, vault).catch(() => {});
    }
    return 0;
  }

  return newAccumulator;
}

// ── Compaction Classification ───────────────────────────────────────────────

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
