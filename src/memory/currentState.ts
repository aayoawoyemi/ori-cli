/**
 * Current State Layer — the agent's fresh truth per turn.
 *
 * Separate from preflight (which pulls historical graph notes). This lane
 * reads operational state from the vault — identity, active goals, today's
 * pending items, recent completions. Calls vault.orient() fresh each turn.
 *
 * Injected CLOSER to generation than preflight's historical block, so when
 * current state and historical memory conflict, current state wins.
 *
 * This is the fix for Finding 1 (vault.orient() was terminal-only) and the
 * architectural answer to "my agent keeps acting on stale state."
 */
import type { OriVault } from './vault.js';

const MAX_CURRENT_STATE_CHARS = 1600; // roughly 400 tokens

interface CurrentStateData {
  identityLine?: string;
  activeGoals: string[];
  pendingToday: string[];
  lastReflection?: string;
}

/**
 * Call vault.orient() and format a current-state block for per-turn injection.
 * Returns empty string if vault unavailable or no state found.
 */
export async function assembleCurrentState(
  vault: OriVault | null,
): Promise<string> {
  if (!vault?.connected) return '';

  let data: CurrentStateData = { activeGoals: [], pendingToday: [] };
  try {
    const orient = await vault.orient() as {
      identity?: string;
      goals?: string;
      daily?: string;
    } | null;
    if (!orient) return '';
    data = parseOrient(orient);
  } catch {
    return '';
  }

  // Build the block
  const lines: string[] = [];
  const asOf = new Date().toISOString().split('T')[0];
  lines.push(`# Current State (as of ${asOf})`);
  lines.push('');

  if (data.identityLine) {
    lines.push(`**Identity:** ${data.identityLine}`);
    lines.push('');
  }

  if (data.activeGoals.length > 0) {
    lines.push('**Active threads:**');
    for (const g of data.activeGoals.slice(0, 5)) {
      lines.push(`- ${g}`);
    }
    lines.push('');
  }

  if (data.pendingToday.length > 0) {
    lines.push('**Today (pending):**');
    for (const p of data.pendingToday.slice(0, 8)) {
      lines.push(`- ${p}`);
    }
    lines.push('');
  }

  if (data.lastReflection) {
    lines.push(`**Last reflection:** "${data.lastReflection}"`);
  }

  if (lines.length <= 2) return ''; // only the header — nothing to say

  let block = lines.join('\n').trim();
  if (block.length > MAX_CURRENT_STATE_CHARS) {
    block = block.slice(0, MAX_CURRENT_STATE_CHARS).trim() + '\n\n(truncated)';
  }
  return block;
}

// ── Markdown parsers ──────────────────────────────────────────────────────────

function parseOrient(orient: {
  identity?: string;
  goals?: string;
  daily?: string;
}): CurrentStateData {
  return {
    identityLine: extractIdentityLine(orient.identity ?? ''),
    activeGoals: extractActiveThreads(orient.goals ?? ''),
    pendingToday: extractPendingToday(orient.daily ?? ''),
  };
}

function extractIdentityLine(identityMd: string): string {
  if (!identityMd) return '';
  // Strip frontmatter
  const stripped = identityMd.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const line of stripped.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('<!--')) continue;
    if (s.startsWith('#')) return s.replace(/^#+\s*/, '').slice(0, 160);
    if (s.length > 20 && !s.startsWith('-')) return s.slice(0, 160);
  }
  return '';
}

function extractActiveThreads(goalsMd: string): string[] {
  if (!goalsMd) return [];
  const threads: string[] = [];
  let inActiveSection = false;
  for (const line of goalsMd.split('\n')) {
    const s = line.trim();
    if (s.startsWith('#')) {
      const lower = s.toLowerCase();
      inActiveSection = /active|current|threads|priorit/.test(lower);
      continue;
    }
    if (!inActiveSection) continue;
    if (!s.startsWith('- ')) continue;
    const item = s.slice(2).replace(/^\[[\sx]\]\s*/, '').trim();
    if (!item) continue;
    if (s.includes('[x]')) continue; // skip completed
    threads.push(item.slice(0, 160));
    if (threads.length >= 10) break;
  }
  return threads;
}

function extractPendingToday(dailyMd: string): string[] {
  if (!dailyMd) return [];

  // Check frontmatter date — if not today, return empty to prevent stale injection
  const dateMatch = dailyMd.match(/^---\n[\s\S]*?date:\s*(\d{4}-\d{2}-\d{2})/m);
  if (dateMatch) {
    const fileDate = dateMatch[1];
    const today = new Date().toISOString().split('T')[0];
    if (fileDate !== today) return []; // stale file — don't inject old tasks
  }

  const pending: string[] = [];
  const m = dailyMd.match(/##\s*(?:Pending Today|Today)\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (!m) return [];
  for (const line of m[1].split('\n')) {
    const s = line.trim();
    if (!s.startsWith('- [ ]')) continue;
    const item = s.slice(5).trim();
    if (item) pending.push(item.slice(0, 200));
    if (pending.length >= 12) break;
  }
  return pending;
}
