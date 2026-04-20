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
  // Shrunk 2026-04-19: identity + goals only, capped tighter. The two extra
  // vault queries (last-reflection, top-warm-notes) were removed entirely —
  // they pulled ~3-5 lines of low-signal titles into every session-start
  // prompt and round-tripped through MCP for almost no value. The model can
  // pull warm notes via vault.query_warmth() in the Repl when relevant.
  const sections: string[] = [];

  if (identity?.identity) {
    const core = identity.identity.slice(0, 400).trim();
    sections.push(`Identity: ${core}`);
  }

  if (identity?.goals) {
    const goals = identity.goals.slice(0, 400).trim();
    sections.push(`Active goals:\n${goals}`);
  }

  // suppress unused-param warning while keeping the call signature stable
  void vault;

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
