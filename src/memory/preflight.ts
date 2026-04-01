import type { Message } from '../router/types.js';
import type { OriVault, VaultNote } from './vault.js';
import type { ProjectBrain, ProjectMemory } from './projectBrain.js';
import { findLast, getMessageText } from '../utils/messages.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PreflightNote {
  title: string;
  score?: number;
  source: 'project' | 'ranked' | 'warmth' | 'important';
}

export interface PreflightContext {
  projectNotes: PreflightNote[];
  vaultNotes: PreflightNote[];
  contextBlock: string;
  queriedAt: number;
}

// ── Preflight Engine ────────────────────────────────────────────────────────

/**
 * Run dual-tier memory retrieval BEFORE every model call.
 * Searches project brain and vault in parallel.
 * Returns a context block to inject into the conversation.
 */
export async function runPreflight(
  messages: Message[],
  projectBrain: ProjectBrain | null,
  vault: OriVault | null,
): Promise<PreflightContext | null> {
  // Get the user's most recent message
  const lastUser = findLast(messages, 'user');
  if (!lastUser) return null;

  const query = getMessageText(lastUser);
  if (!query || query.length < 5) return null;

  // Build broader context from recent exchanges for warmth queries
  const recentContext = messages
    .slice(-6)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => getMessageText(m).slice(0, 200))
    .join(' ');

  // ── Run ALL retrieval strategies in parallel across BOTH tiers ──────

  const [projectResults, ranked, warmth, important] = await Promise.all([
    // Tier 2: Project brain (keyword search)
    projectBrain ? searchProjectBrain(projectBrain, query) : Promise.resolve([]),

    // Tier 3: Vault ranked (semantic + graph)
    vault?.connected ? vault.queryRanked(query, 5) : Promise.resolve([]),

    // Tier 3: Vault warmth (associative activation)
    vault?.connected ? vault.queryWarmth(recentContext, 3) : Promise.resolve([]),

    // Tier 3: Vault important (global structural authority)
    vault?.connected ? vault.queryImportant(2) : Promise.resolve([]),
  ]);

  // ── Deduplicate across all sources ──────────────────────────────────

  const seen = new Set<string>();
  const projectNotes: PreflightNote[] = [];
  const vaultNotes: PreflightNote[] = [];

  for (const mem of projectResults) {
    const key = mem.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      projectNotes.push({ title: mem.title, score: mem.score, source: 'project' });
    }
  }

  for (const note of [...ranked, ...warmth, ...important]) {
    const key = note.title.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      vaultNotes.push({
        title: note.title,
        score: note.score,
        source: (note.source as 'ranked' | 'warmth' | 'important') ?? 'ranked',
      });
    }
  }

  if (projectNotes.length === 0 && vaultNotes.length === 0) return null;

  // ── Assemble context block ──────────────────────────────────────────

  const sections: string[] = [];

  if (projectNotes.length > 0) {
    const lines = projectNotes.map(n => `- "${n.title}"`).join('\n');
    sections.push(`## Project Knowledge\n${lines}`);
  }

  if (vaultNotes.length > 0) {
    const lines = vaultNotes.map(n => {
      const scoreStr = n.score ? ` (${n.source}, ${n.score.toFixed(2)})` : ` (${n.source})`;
      return `- "${n.title}"${scoreStr}`;
    }).join('\n');
    sections.push(`## Vault Knowledge\n${lines}`);
  }

  const contextBlock = `<memory-context>\nRelevant memories retrieved before this turn:\n\n${sections.join('\n\n')}\n</memory-context>`;

  return {
    projectNotes,
    vaultNotes,
    contextBlock,
    queriedAt: Date.now(),
  };
}

// ── Inject preflight context into messages ──────────────────────────────────

/**
 * Inject preflight context as a system-reminder attached to the last user message.
 * This preserves the system prompt cache (same pattern as Claude Code's userContext).
 */
export function injectPreflightContext(messages: Message[], preflight: PreflightContext): Message[] {
  const result = [...messages];

  // Find the last user message and append the context
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user' && typeof result[i].content === 'string') {
      result[i] = {
        ...result[i],
        content: `${result[i].content}\n\n<system-reminder>\n${preflight.contextBlock}\n</system-reminder>`,
      };
      return result;
    }
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function searchProjectBrain(brain: ProjectBrain, query: string): Promise<ProjectMemory[]> {
  try {
    return brain.search(query, 5);
  } catch {
    return [];
  }
}
