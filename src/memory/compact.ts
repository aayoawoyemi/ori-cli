import type { Message, ContentBlock } from '../router/types.js';
import type { ModelRouter } from '../router/index.js';
import type { OriVault } from './vault.js';
import type { ProjectBrain } from './projectBrain.js';
import { estimateTokens } from '../utils/tokens.js';
import { getMessageText } from '../utils/messages.js';
import { getWarmContextForCompaction } from './warmContext.js';
import { appendExperience } from './experienceLog.js';

// ── Constants ───────────────────────────────────────────────────────────────

const PRUNE_PROTECT_TOKENS = 40_000;  // protect this many recent tool result tokens
const PRUNE_MINIMUM_TOKENS = 20_000;  // only prune if we can free at least this much

// ── Types ───────────────────────────────────────────────────────────────────

export interface SavedInsight {
  title: string;
  content: string;
  type: string;
  tier: 'project' | 'vault';
  destination: string;
}

export interface CompactResult {
  messages: Message[];
  summary: string;
  saved: SavedInsight[];
  pruneOnly: boolean;
}

// ── Phase 0: Prune Tool Outputs ─────────────────────────────────────────────

/**
 * Walk backwards through messages, erase old tool result content.
 * Keep the call skeleton so the model knows what tools were used.
 * Protect the most recent tool results (last PRUNE_PROTECT_TOKENS worth).
 * Returns the number of tokens freed.
 *
 * Adopted from OpenCode/KiloCode two-phase compaction pattern.
 */
function pruneToolOutputs(messages: Message[]): number {
  let protectedTokens = 0;
  let freedTokens = 0;

  // Walk backwards — protect recent tool results
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // Prune string-content tool results (from buildToolResultMessage)
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlock[]) {
        if (block.type !== 'tool_result') continue;
        if (block.content === '[output pruned]') continue; // already pruned

        const tokenEst = Math.ceil(block.content.length / 4);

        if (protectedTokens < PRUNE_PROTECT_TOKENS) {
          protectedTokens += tokenEst;
          continue;
        }

        // Prune this result
        freedTokens += tokenEst;
        block.content = '[output pruned]';
      }
    }
  }

  return freedTokens;
}

// ── Phase 1+2: Extract, Classify, Save ──────────────────────────────────────

async function extractAndSave(
  messages: Message[],
  router: ModelRouter,
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  projectDir?: string,
): Promise<SavedInsight[]> {
  const conversationText = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `[${m.role}]: ${getMessageText(m).slice(0, 500)}`)
    .join('\n\n');

  if (conversationText.length < 200) return [];

  const extractionPrompt = `You are extracting durable knowledge from a coding conversation.
For each insight, classify it:
- "project": specific to this codebase (test commands, conventions, architecture decisions)
- "vault": universal knowledge that applies across projects (technical patterns, API behaviors)

Skip ephemeral items (debugging steps, temporary fixes). Return 3-7 items max.
Return ONLY a JSON array: [{"title": "prose claim", "content": "brief explanation", "type": "decision|learning|insight", "tier": "project|vault"}]`;

  try {
    const result = await router.cheapCall(extractionPrompt, [
      { role: 'user', content: conversationText.slice(0, 8000) },
    ]);

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const insights = JSON.parse(jsonMatch[0]) as Array<{
      title: string; content: string; type: string; tier: string;
    }>;

    const saved: SavedInsight[] = [];

    for (const insight of insights) {
      if (!insight.title || !insight.content) continue;

      if (insight.tier === 'vault' && vault?.connected) {
        const ok = await vault.add(insight.title, insight.content, insight.type || 'insight');
        if (ok) saved.push({ ...insight, tier: 'vault', destination: 'vault' });
      } else if (insight.tier === 'project' && projectBrain) {
        projectBrain.save(insight.title, insight.content, insight.type || 'learning');
        saved.push({ ...insight, tier: 'project', destination: 'project' });
      }
    }

    // Append to experience log (project-local ambient memory)
    if (saved.length > 0 && projectDir) {
      for (const s of saved) {
        await appendExperience(projectDir, s.title).catch(() => {});
      }
    }

    return saved;
  } catch {
    return [];
  }
}

// ── Phase 3: Structured Summary ─────────────────────────────────────────────

async function generateStructuredSummary(
  messages: Message[],
  saved: SavedInsight[],
  router: ModelRouter,
): Promise<string> {
  const savedSection = saved.length > 0
    ? saved.map(s => `- "${s.title}" → ${s.destination}`).join('\n')
    : 'No notes saved this compaction.';

  const summaryPrompt = `Write a structured summary of this coding conversation for continuation.
Use these exact sections:

## Goal
What is the overall objective?

## Instructions and Constraints
Any rules, preferences, or constraints the user specified.

## Discoveries
Technical facts, decisions made, things learned during this work.

## Work Accomplished
What was done, what files were changed, current state.

## Relevant Files
Key files that were read or modified (with paths).

## Saved Notes
${savedSection}

Be specific. Include file paths, function names, error messages. The model continuing
this conversation will have NO context besides this summary and preflight memories.`;

  const conversationText = messages
    .map(m => `[${m.role}]: ${getMessageText(m).slice(0, 300)}`)
    .join('\n');

  try {
    return await router.cheapCall(summaryPrompt, [
      { role: 'user', content: conversationText.slice(0, 12000) },
    ]);
  } catch {
    // Fallback: crude summary
    const lastUser = messages.filter(m => m.role === 'user').pop();
    return `## Goal\nContinue previous work.\n\n## Context\nLast user message: ${getMessageText(lastUser!).slice(0, 500)}`;
  }
}

// ── Main Compaction Pipeline ────────────────────────────────────────────────

/**
 * 4-phase compaction pipeline:
 *   Phase 0: PRUNE old tool outputs (may be sufficient alone)
 *   Phase 1: EXTRACT durable insights with cheap model
 *   Phase 2: SAVE to appropriate tier (project brain / vault)
 *   Phase 3: STRUCTURED SUMMARY referencing saved notes
 *   Phase 4: REPLACE conversation with summary + boundary
 */
export async function runCompaction(
  messages: Message[],
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  router: ModelRouter,
  contextThreshold: number,
  projectDir?: string,
): Promise<CompactResult> {

  // ── Phase 0: Prune ──────────────────────────────────────────────────
  const freedTokens = pruneToolOutputs(messages);
  const currentTokens = estimateTokens(messages);

  // If pruning alone got us below threshold, we're done. No LLM call needed.
  if (freedTokens >= PRUNE_MINIMUM_TOKENS && currentTokens < contextThreshold) {
    return {
      messages,
      summary: `[pruned ${freedTokens} tokens of tool outputs]`,
      saved: [],
      pruneOnly: true,
    };
  }

  // ── Phase 1+2: Extract and save insights ────────────────────────────
  const saved = await extractAndSave(messages, router, projectBrain, vault, projectDir);

  // ── Phase 3: Structured summary ─────────────────────────────────────
  const summary = await generateStructuredSummary(messages, saved, router);

  // ── Phase 4: Replace ────────────────────────────────────────────────
  const savedInfo = saved.length > 0
    ? `\n\n${saved.length} insights saved to persistent memory (${saved.filter(s => s.tier === 'vault').length} vault, ${saved.filter(s => s.tier === 'project').length} project). These will be available via preflight retrieval.`
    : '';

  // Prepend warm context so identity/goals/reflections survive compaction
  const warmBlock = getWarmContextForCompaction();
  const warmPrefix = warmBlock ? `${warmBlock}\n\n` : '';

  const compactedMessages: Message[] = [
    {
      role: 'user',
      content: `${warmPrefix}<compaction-summary>\nThis is a structured summary of the previous conversation:\n\n${summary}${savedInfo}\n</compaction-summary>\n\nContinue from where we left off.`,
      meta: {
        type: 'compact_boundary',
        compactedAt: Date.now(),
        insightsSaved: saved.length,
      },
    },
  ];

  // ── Post-compaction breadcrumb ──────────────────────────────────────
  // Write a lightweight vault note marking the compaction. Not forced into
  // retrieval — just there if you go looking. Gives the model a felt sense
  // of session compression history.
  if (vault?.connected) {
    const ts = new Date().toISOString();
    const vaultCount = saved.filter(s => s.tier === 'vault').length;
    const projectCount = saved.filter(s => s.tier === 'project').length;
    const breadcrumbContent = [
      `Session compacted at ${ts}.`,
      `Insights saved: ${saved.length} total (${vaultCount} vault, ${projectCount} project brain).`,
      saved.length > 0 ? `Saved: ${saved.map(s => `"${s.title}"`).join(', ')}.` : '',
      `Summary excerpt: ${summary.slice(0, 200)}`,
    ].filter(Boolean).join(' ');

    await vault.add(
      `Compaction at ${ts} — ${saved.length} insights saved`,
      breadcrumbContent,
      'learning',
    ).catch(() => { /* breadcrumb failure is non-fatal */ });
  }

  return {
    messages: compactedMessages,
    summary,
    saved,
    pruneOnly: false,
  };
}
