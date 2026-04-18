/**
 * Warm Context Layer — the agent's working identity.
 *
 * Assembles a ~2K token block that is ALWAYS present in context:
 * - Identity (who the agent is)
 * - Goals (what's active)
 * - Last reflection (most recent synthesized insight)
 * - Top warm notes (recently active in the graph)
 *
 * This is NOT preflight. Preflight is query-driven (reactive).
 * Warm context is identity-anchored (proactive). It refreshes
 * every N turns or after reflection, not every turn.
 *
 * This block survives compaction. It IS the agent's continuity.
 */

import type { OriVault, VaultIdentity, VaultNote } from './vault.js';

// ── Config ─────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 10; // refresh every N turns
const MAX_WARM_NOTES = 3;

// ── State ──────────────────────────────────────────────────────────────────

let cachedBlock: string = '';
let turnsSinceRefresh = 0;
let initialized = false;

// ── Assembly ───────────────────────────────────────────────────────────────

/**
 * Assemble the warm context block from vault data.
 * Called at session start and periodically during the session.
 */
export async function assembleWarmContext(
  vault: OriVault | null,
  identity: VaultIdentity | null,
): Promise<string> {
  const sections: string[] = [];

  // 1. Identity — who the agent is
  if (identity?.identity) {
    // Take first ~800 chars of identity (the core, not the full file)
    const core = identity.identity.slice(0, 800).trim();
    sections.push(`Identity: ${core}`);
  }

  // 2. Goals — what's active right now
  if (identity?.goals) {
    const goals = identity.goals.slice(0, 800).trim();
    sections.push(`Active goals:\n${goals}`);
  }

  // 3. Last reflection — most recent synthesized insight
  if (vault?.connected) {
    try {
      const reflections = await vault.queryRanked('recent reflection insight synthesis', 1);
      if (reflections.length > 0) {
        sections.push(`Last reflection: "${reflections[0]!.title}"`);
      }
    } catch { /* non-fatal */ }
  }

  // 4. Top warm notes — what's been most active recently
  if (vault?.connected) {
    try {
      const context = identity?.goals ?? 'current work and active projects';
      const warm = await vault.queryWarmth(context, MAX_WARM_NOTES);
      if (warm.length > 0) {
        const lines = warm.map(n => `- "${n.title}"`).join('\n');
        sections.push(`Warm notes (recently active):\n${lines}`);
      }
    } catch { /* non-fatal */ }
  }

  if (sections.length === 0) return '';

  cachedBlock = `<warm-context>\n${sections.join('\n\n')}\n</warm-context>`;
  initialized = true;
  turnsSinceRefresh = 0;

  return cachedBlock;
}

/**
 * Get the current warm context block.
 * Returns cached version unless refresh is due.
 * Call `tickTurn()` after each turn to track refresh timing.
 */
export function getWarmContext(): string {
  return cachedBlock;
}

/**
 * Check if warm context needs refresh (every N turns or after forced refresh).
 */
export function needsRefresh(): boolean {
  if (!initialized) return true;
  return turnsSinceRefresh >= REFRESH_INTERVAL;
}

/**
 * Increment the turn counter. Call after each model turn completes.
 */
export function tickTurn(): void {
  turnsSinceRefresh++;
}

/**
 * Force a refresh on the next check (e.g., after reflection fires).
 */
export function forceRefresh(): void {
  turnsSinceRefresh = REFRESH_INTERVAL;
}

/**
 * Get the warm context block for compaction survival.
 * This is prepended to compacted summaries so identity is never lost.
 */
export function getWarmContextForCompaction(): string {
  return cachedBlock;
}
