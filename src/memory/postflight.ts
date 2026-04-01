import type { Message } from '../router/types.js';
import type { OriVault } from './vault.js';
import type { ProjectBrain } from './projectBrain.js';
import type { PreflightContext } from './preflight.js';
import type { ModelRouter } from '../router/index.js';
import { getMessageText } from '../utils/messages.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const REFLECTION_THRESHOLD = 150;

// ── Postflight Engine ───────────────────────────────────────────────────────

/**
 * Run after every clean model response (no pending tool calls).
 *
 * 1. Vitality is bumped automatically by Ori during retrieval (no manual call needed)
 * 2. Co-access is logged automatically by Ori during ranked queries
 * 3. Accumulate importance for reflection trigger
 *
 * Returns the new importance accumulator value.
 */
export async function runPostflight(
  messages: Message[],
  preflight: PreflightContext | null,
  _projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  currentImportance: number,
): Promise<number> {
  // Note: vitality bumps and co-access logging happen automatically
  // inside Ori's queryRanked during preflight. No manual calls needed.
  // This is a key insight from the Ori API — retrieval IS the vitality mechanism.

  // ── Importance accumulation ─────────────────────────────────────────
  //
  // Tool-using turns indicate substantive work (score 3).
  // Plain conversation turns score 1.
  // When accumulator crosses REFLECTION_THRESHOLD, trigger reflection.

  const recentMessages = messages.slice(-5);
  const hadToolCalls = recentMessages.some(m => {
    if (typeof m.content === 'string') return false;
    return m.content.some(b => b.type === 'tool_use' || b.type === 'tool_result');
  });

  const importance = hadToolCalls ? 3 : 1;
  const newAccumulator = currentImportance + importance;

  // ── Agreement ratio monitoring ───────────────────────────────────────
  // Track whether the model is being a yes-man. If agreement ratio > 0.9
  // over 20 turns, save an observation so future preflight can surface it.
  trackAgreementRatio(messages, vault);

  // ── Reflection trigger ──────────────────────────────────────────────
  if (vault?.connected && newAccumulator >= REFLECTION_THRESHOLD) {
    triggerReflection(messages, vault).catch(() => {});
    return 0;
  }

  return newAccumulator;
}

// ── Reflection ──────────────────────────────────────────────────────────────

/**
 * Smallville importance accumulator pattern.
 * When enough important work accumulates, synthesize recent activity
 * into a high-level insight and save it to the vault.
 */
async function triggerReflection(
  messages: Message[],
  vault: OriVault,
): Promise<void> {
  // Gather recent conversation context (last ~15 messages)
  const recentText = messages
    .slice(-15)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const text = getMessageText(m);
      return `[${m.role}]: ${text.slice(0, 300)}`;
    })
    .join('\n');

  if (recentText.length < 100) return;

  // Create a reflection note from the accumulated work
  // This is a simplified version — Phase 3 will use the cheap model for better synthesis
  const title = generateReflectionTitle(messages);
  const content = `Reflection synthesized from ${messages.length} messages of accumulated work.\n\n${recentText.slice(0, 2000)}`;

  await vault.add(title, content, 'insight');
}

function generateReflectionTitle(messages: Message[]): string {
  // Extract the most common substantive terms from recent user messages
  const userText = messages
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => getMessageText(m))
    .join(' ');

  // Simple keyword extraction — take the first meaningful phrase
  const words = userText.split(/\s+/).filter(w => w.length > 4).slice(0, 6);
  if (words.length === 0) return 'session reflection on recent work';

  return `reflection on ${words.join(' ').toLowerCase().slice(0, 60)}`;
}

// ── Agreement Ratio Monitoring ───────────────────────────────────────────────

const AGREEMENT_SIGNALS = ['yes', 'agree', 'good idea', 'makes sense', 'exactly', 'correct', 'sounds good', 'great', 'perfect'];
const PUSHBACK_SIGNALS = ['however', 'but ', 'actually', 'instead', 'issue with', 'problem', 'concern', 'careful', 'not sure', 'don\'t have a basis'];
const AGREEMENT_WINDOW = 20;
const AGREEMENT_THRESHOLD = 0.9;

let agreementHistory: boolean[] = []; // true = agreed, false = pushed back

function trackAgreementRatio(messages: Message[], vault: OriVault | null): void {
  // Get the last assistant message
  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  if (!lastAssistant) return;

  const text = getMessageText(lastAssistant).toLowerCase();
  if (text.length < 20) return; // skip trivial responses

  const agreeCount = AGREEMENT_SIGNALS.filter(s => text.includes(s)).length;
  const pushCount = PUSHBACK_SIGNALS.filter(s => text.includes(s)).length;

  // Classify this turn
  const agreed = agreeCount > pushCount;
  agreementHistory.push(agreed);

  // Keep rolling window
  if (agreementHistory.length > AGREEMENT_WINDOW) {
    agreementHistory = agreementHistory.slice(-AGREEMENT_WINDOW);
  }

  // Check ratio
  if (agreementHistory.length >= AGREEMENT_WINDOW) {
    const ratio = agreementHistory.filter(a => a).length / agreementHistory.length;
    if (ratio >= AGREEMENT_THRESHOLD && vault?.connected) {
      vault.add(
        'high agreement ratio detected — possible sycophantic drift',
        `Agreement ratio: ${(ratio * 100).toFixed(0)}% over last ${AGREEMENT_WINDOW} turns. The model may be validating without substance. Review recent decisions critically.`,
        'insight',
      ).catch(() => {});
      // Reset so we don't spam
      agreementHistory = [];
    }
  }
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
    ]);

    // Parse JSON from the response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const insights = JSON.parse(jsonMatch[0]) as ExtractedInsight[];
    return insights.filter(i => i.title && i.content && i.tier !== 'ephemeral');
  } catch {
    return [];
  }
}
