import type { Message } from '../router/types.js';
import type { OriVault, VaultNote } from './vault.js';
import type { ProjectBrain, ProjectMemory } from './projectBrain.js';
import { findLast, getMessageText } from '../utils/messages.js';
import type { PreflightConfig } from '../config/types.js';

/**
 * Resolve preflight.enabled from config.
 * 'auto' → preflight is disabled when REPL is enabled (REPL-mode agents pull
 * memory on-demand via vault.query_*, so ambient preflight becomes overhead).
 */
export function resolvePreflightEnabled(
  preflight: PreflightConfig,
  _replEnabled: boolean,
): boolean {
  // Re-enabled 2026-04-17. REPL mode still needs reactive retrieval —
  // the agent cannot search for what it doesn't know exists.
  // Preflight bridges user intent to vault knowledge.
  if (preflight.enabled === 'auto') return true;
  return preflight.enabled;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface PreflightNote {
  title: string;
  score?: number;
  source: 'project' | 'ranked' | 'warmth' | 'explore' | 'similar';
  contradicting?: boolean;
}

export interface PreflightContext {
  projectNotes: PreflightNote[];
  vaultNotes: PreflightNote[];
  /** Semantic + topology block — injected BEFORE user message (high attention) */
  beforeUserBlock: string;
  /** Contradictions + proprioception — injected AFTER user message (highest salience) */
  afterUserBlock: string;
  /** Legacy single block (for logging) */
  contextBlock: string;
  queriedAt: number;
}

// ── Preflight Engine ────────────────────────────────────────────────────────

/**
 * Run dual-tier GRAPH-AWARE memory retrieval before every model call.
 *
 * RMH entry point — not flat search, but graph traversal.
 * Each ori_query_ranked call feeds Q-values, spreading activation,
 * and stage-learner. The act of searching makes future searches better.
 */
export async function runPreflight(
  messages: Message[],
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
  identityContext?: string,
): Promise<PreflightContext | null> {
  const lastUser = findLast(messages, 'user');
  if (!lastUser) return null;

  const rawQuery = getMessageText(lastUser);
  if (!rawQuery || rawQuery.length < 5) return null;

  // ── Identity-conditioned query ─────────────────────────────────────
  // Conway's Self-Memory System: identity conditions which memories activate.
  // Prefix the query with identity context so Q-values learn what matters
  // to THIS agent, not generic relevance.
  const query = identityContext
    ? `[${identityContext.slice(0, 150)}] ${rawQuery}`
    : rawQuery;

  const recentMessages = messages
    .slice(-6)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => getMessageText(m).slice(0, 200))
    .join(' ');

  const lastAssistant = messages.filter(m => m.role === 'assistant').pop();
  const assistantText = lastAssistant ? getMessageText(lastAssistant).slice(0, 300) : '';

  // ── Rich warmth context ────────────────────────────────────────────
  // Pass identity + goals + recent conversation to warmth.
  // More text → better embedding seeds → more notes activate.
  // This goes to a LOCAL embedding model (no API cost, ~50ms).
  const warmthContext = [
    identityContext ? `Agent: ${identityContext}` : '',
    recentMessages,
    assistantText,
  ].filter(Boolean).join(' ');

  // ── Project brain (always local, not in ori_preflight) ────────────────
  const projectResults = projectBrain
    ? await searchProjectBrain(projectBrain, rawQuery)
    : [];

  // ── Vault retrieval: try compound ori_preflight, fall back to 5-way ──
  let vaultNotes: PreflightNote[] = [];
  const projectNotes: PreflightNote[] = [];

  const seen = new Set<string>();
  for (const mem of projectResults) {
    const key = mem.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      projectNotes.push({ title: mem.title, score: mem.score, source: 'project' });
    }
  }

  // Try single-call preflight (requires ori_preflight in Ori >= 0.5.x)
  const compoundResult = vault?.connected
    ? await vault.preflight(query, warmthContext, 5)
    : null;

  if (compoundResult && compoundResult.notes.length > 0) {
    // Server-side dedup + contradiction detection — just map to our type
    for (const n of compoundResult.notes) {
      const key = n.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        vaultNotes.push({
          title: n.title,
          score: n.score,
          source: n.source as PreflightNote['source'],
          contradicting: n.contradicting,
        });
      }
    }
  } else if (vault?.connected) {
    // Fallback: 5-way fan-out (old Ori version or preflight failure)
    const [ranked, warmth, explored, similar] = await Promise.all([
      vault.queryRanked(query, 5),
      vault.queryWarmth(warmthContext, 3),
      vault.explore(rawQuery, 5, 2),
      assistantText.length > 20
        ? vault.querySimilar(assistantText, 3)
        : Promise.resolve([]),
    ]);

    const vaultSources: Array<{ notes: VaultNote[]; source: PreflightNote['source'] }> = [
      { notes: ranked, source: 'ranked' },
      { notes: warmth, source: 'warmth' },
      { notes: explored, source: 'explore' },
      { notes: similar, source: 'similar' },
    ];

    for (const { notes, source } of vaultSources) {
      for (const note of notes) {
        const key = note.title.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          vaultNotes.push({ title: note.title, score: note.score, source });
        }
      }
    }

    // Legacy keyword contradiction flagging (only in fallback path)
    flagContradictions([...projectNotes, ...vaultNotes], query);
  }

  if (projectNotes.length === 0 && vaultNotes.length === 0) return null;

  const allNotes = [...projectNotes, ...vaultNotes];

  // ── Split into positional blocks ───────────────────────────────────
  // Lost in the Middle (Stanford/Meta TACL 2024): 30%+ degradation for
  // middle-positioned context. We put semantic notes BEFORE user message
  // (high attention) and contradictions AFTER (closest to generation).

  const contradicting = allNotes.filter(n => n.contradicting);
  const nonContradicting = allNotes.filter(n => !n.contradicting);

  // BEFORE USER MESSAGE: semantic topology (non-contradicting notes)
  const beforeSections: string[] = [];

  const projectNonContra = nonContradicting.filter(n => n.source === 'project');
  if (projectNonContra.length > 0) {
    beforeSections.push(`## Project Knowledge\n${projectNonContra.map(formatNote).join('\n')}`);
  }

  const vaultNonContra = nonContradicting.filter(n => n.source !== 'project');
  if (vaultNonContra.length > 0) {
    const bySource = new Map<string, PreflightNote[]>();
    for (const n of vaultNonContra) {
      const existing = bySource.get(n.source) ?? [];
      existing.push(n);
      bySource.set(n.source, existing);
    }

    const sourceLabels: Record<string, string> = {
      ranked: 'Semantic match',
      warmth: 'Warm from recent activity',
      explore: 'Graph-adjacent (1-2 hops)',
      similar: 'Structurally similar to conversation',
    };

    const lines: string[] = [];
    for (const [source, notes] of bySource) {
      lines.push(`### ${sourceLabels[source] ?? source}`);
      for (const n of notes) lines.push(formatNote(n));
    }
    beforeSections.push(`## Vault Knowledge\n${lines.join('\n')}`);
  }

  const beforeUserBlock = beforeSections.length > 0
    ? `<memory-context>\n${beforeSections.join('\n\n')}\n\nNotes from different paths may reveal connections.\n</memory-context>`
    : '';

  // AFTER USER MESSAGE: contradictions as required-response blocks
  const afterParts: string[] = [];

  for (const note of contradicting) {
    afterParts.push(
      `<required-response>\nYour vault says: "${note.title}"\nThis contradicts the current approach. Address this tension before proceeding — acknowledge, resolve, or explain why the prior learning no longer applies.\n</required-response>`
    );
  }

  const afterUserBlock = afterParts.join('\n\n');

  // Legacy combined block for logging
  const contextBlock = [beforeUserBlock, afterUserBlock].filter(Boolean).join('\n\n');

  return {
    projectNotes,
    vaultNotes,
    beforeUserBlock,
    afterUserBlock,
    contextBlock,
    queriedAt: Date.now(),
  };
}

// ── Positional Injection ────────────────────────────────────────────────────

/**
 * Inject preflight context at two positions in the message array:
 * 1. BEFORE the last user message — semantic notes (high attention)
 * 2. AFTER the last user message — contradictions + proprioception (highest salience)
 *
 * This follows Lost in the Middle research: important content at edges,
 * not in the middle of the conversation.
 */
export function injectPreflightContext(
  messages: Message[],
  preflight: PreflightContext,
  proprioceptionBlock?: string,
): void {
  // Find the last user message index
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return;

  // BEFORE: inject semantic notes as a system-reminder on the message before the user
  if (preflight.beforeUserBlock) {
    // Prepend to the user message as a leading context block
    const userContent = messages[lastUserIdx].content as string;
    messages[lastUserIdx] = {
      ...messages[lastUserIdx],
      content: `<system-reminder>\n${preflight.beforeUserBlock}\n</system-reminder>\n\n${userContent}`,
    };
  }

  // AFTER: append contradictions + proprioception after the user message content
  const afterParts: string[] = [];
  if (preflight.afterUserBlock) {
    afterParts.push(preflight.afterUserBlock);
  }
  if (proprioceptionBlock) {
    afterParts.push(`<system-reminder>\n${proprioceptionBlock}\n</system-reminder>`);
  }

  if (afterParts.length > 0) {
    const userContent = messages[lastUserIdx].content as string;
    messages[lastUserIdx] = {
      ...messages[lastUserIdx],
      content: `${userContent}\n\n${afterParts.join('\n\n')}`,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const CONTRADICTION_SIGNALS = [
  'failed', 'failure', 'broken', 'wrong', 'problem', 'issue', 'bug',
  'doesn\'t work', 'not work', 'avoid', 'don\'t use', 'mistake',
  'worse', 'slow', 'crash', 'couldn\'t', 'unable', 'rejected',
  'dangerous', 'risky', 'bad idea',
];

function flagContradictions(notes: PreflightNote[], userQuery: string): void {
  const queryLower = userQuery.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(w => w.length > 3);

  for (const note of notes) {
    const titleLower = note.title.toLowerCase();
    const topicOverlap = queryTerms.some(term => titleLower.includes(term));
    if (!topicOverlap) continue;

    const hasContradiction = CONTRADICTION_SIGNALS.some(sig => titleLower.includes(sig));
    if (hasContradiction) {
      note.contradicting = true;
    }
  }
}

function formatNote(n: PreflightNote): string {
  const scoreStr = n.score ? ` (${n.score.toFixed(2)})` : '';
  return `- "${n.title}"${scoreStr}`;
}

async function searchProjectBrain(brain: ProjectBrain, query: string): Promise<ProjectMemory[]> {
  try {
    return brain.search(query, 5);
  } catch {
    return [];
  }
}
