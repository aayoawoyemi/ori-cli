/**
 * Echo/Fizzle Tracking — closes the RMH feedback loop.
 *
 * After each assistant response, determine which preflight notes
 * the model actually USED (echo) vs IGNORED (fizzle).
 *
 * Echo: note title terms appear in the response → boost via ori_update
 *   (triggers vitality bump + spreading activation in Ori)
 * Fizzle: note was retrieved but not referenced → natural decay handles it
 *   (no negative signal sent — absence of boost IS the signal)
 *
 * This feeds Ori's Q-value system: notes that consistently echo
 * get higher Q-values → rank higher in future retrievals.
 * Notes that consistently fizzle decay naturally → rank lower.
 *
 * Research backing: "echo fizzle feedback loop closes the gap between
 * memory retrieval and memory utility" (vault note)
 */

import type { OriVault } from './vault.js';
import type { PreflightContext, PreflightNote } from './preflight.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface EchoFizzleResult {
  echoed: string[];   // note titles the model used
  fizzled: string[];  // note titles the model ignored
}

// ── Detection ──────────────────────────────────────────────────────────────

/**
 * Scan the assistant's response for references to preflight notes.
 *
 * Heuristic: extract significant words (>4 chars) from each note title.
 * If 2+ title words appear in the response, it's an echo.
 * Otherwise it's a fizzle.
 *
 * This is a conservative heuristic — it underreports echoes rather
 * than overreporting. False negatives (missing an echo) are fine;
 * false positives (calling a fizzle an echo) would corrupt Q-values.
 */
export function detectEchoFizzle(
  assistantText: string,
  preflight: PreflightContext,
): EchoFizzleResult {
  const responseLower = assistantText.toLowerCase();
  const echoed: string[] = [];
  const fizzled: string[] = [];

  const allNotes = [...preflight.projectNotes, ...preflight.vaultNotes];

  for (const note of allNotes) {
    // Skip project-brain notes — they don't have Q-values in Ori
    if (note.source === 'project') continue;

    const titleWords = note.title
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 4)
      // Remove very common words that would false-positive
      .filter(w => !STOPWORDS.has(w));

    if (titleWords.length === 0) continue;

    // Count how many title words appear in the response
    const matchCount = titleWords.filter(w => responseLower.includes(w)).length;

    // Require 2+ matches for short titles, 3+ for long titles
    const threshold = titleWords.length <= 4 ? 2 : 3;

    if (matchCount >= threshold) {
      echoed.push(note.title);
    } else {
      fizzled.push(note.title);
    }
  }

  return { echoed, fizzled };
}

// ── Reward Dispatch ────────────────────────────────────────────────────────

/**
 * Send echo signals to Ori via vault.update().
 * Each update triggers:
 *   - Vitality bump on the note
 *   - Spreading activation to wiki-link neighbors
 *   - Boost entry in the SQLite boosts table
 *
 * Fizzled notes get NO signal — natural decay handles them.
 * This is intentional: sending negative signals for fizzle would
 * punish notes that are relevant but not cited (the model used
 * the knowledge without explicitly referencing the title).
 */
export async function sendEchoSignals(
  result: EchoFizzleResult,
  vault: OriVault | null,
): Promise<void> {
  if (!vault?.connected || result.echoed.length === 0) return;

  // Fire-and-forget: don't block the loop waiting for Q-value updates
  const updates = result.echoed.map(title =>
    vault.update(title).catch(() => {})
  );

  await Promise.all(updates);
}

// ── Stopwords ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'about', 'after', 'again', 'because', 'before', 'being',
  'between', 'could', 'different', 'during', 'every', 'first',
  'found', 'should', 'their', 'there', 'these', 'thing',
  'think', 'those', 'through', 'under', 'using', 'where',
  'which', 'while', 'would', 'other', 'another', 'makes',
  'means', 'needs', 'never', 'still', 'since', 'based',
]);
