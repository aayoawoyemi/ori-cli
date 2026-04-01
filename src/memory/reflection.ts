import type { Message } from '../router/types.js';
import type { OriVault } from './vault.js';
import type { ModelRouter } from '../router/index.js';
import { getMessageText } from '../utils/messages.js';

/**
 * Smallville importance accumulator pattern — LLM-driven synthesis.
 * When enough important work accumulates, use the cheap model to
 * synthesize recent activity into a high-level insight.
 */
export async function triggerReflectionWithModel(
  messages: Message[],
  vault: OriVault,
  router: ModelRouter,
): Promise<void> {
  // Gather recent conversation (last ~15 exchanges)
  const recentText = messages
    .slice(-30)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${getMessageText(m).slice(0, 300)}`)
    .join('\n');

  if (recentText.length < 200) return;

  const reflectionPrompt = `You are synthesizing a high-level insight from a coding session.
Review the recent conversation and identify ONE cross-cutting pattern, decision, or learning
that would be valuable to remember in future sessions across any project.

Focus on:
- Architecture patterns that worked (or didn't)
- Debugging strategies that were effective
- Design decisions with rationale
- Technical discoveries about APIs, tools, or frameworks

Write a single prose-as-title claim (the insight itself) and a brief explanation (2-3 sentences).
Return JSON: {"title": "the insight as a complete claim", "content": "explanation"}`;

  try {
    const result = await router.cheapCall(reflectionPrompt, [
      { role: 'user', content: recentText.slice(0, 6000) },
    ]);

    const jsonMatch = result.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return;

    const parsed = JSON.parse(jsonMatch[0]) as { title: string; content: string };
    if (!parsed.title || parsed.title.length < 10) return;

    await vault.add(parsed.title, parsed.content, 'insight');
  } catch {
    // Reflection failure is never critical
  }
}

/**
 * Simple reflection without LLM (fallback when no cheap model available).
 * Extracts keywords from recent messages as a crude topic summary.
 */
export async function triggerReflectionSimple(
  messages: Message[],
  vault: OriVault,
): Promise<void> {
  const recentUserText = messages
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => getMessageText(m))
    .join(' ');

  if (recentUserText.length < 100) return;

  // Simple keyword extraction
  const words = recentUserText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4);

  // Count frequencies
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const topWords = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);

  if (topWords.length < 2) return;

  const title = `session reflection on ${topWords.join(' ')}`;
  const content = `Auto-generated reflection from ${messages.length} messages. Key topics: ${topWords.join(', ')}.`;

  await vault.add(title, content, 'insight').catch(() => {});
}
