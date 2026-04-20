/**
 * Experience Log — project-local learnings that persist across sessions.
 *
 * Lives at .aries/experience.md. Written during compaction (extractAndSave),
 * read at prompt build time into the cached prefix. ~30 entries, FIFO eviction.
 *
 * Token cost: ~400 tokens (30 entries × ~13 tokens). Cached after turn 1.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MAX_ENTRIES = 30;
const ENTRY_RE = /^- \[\d{4}-\d{2}-\d{2}\] .+$/;

export function experienceLogPath(projectDir: string): string {
  return join(projectDir, '.aries', 'experience.md');
}

/**
 * Append a one-liner to the experience log. FIFO evicts oldest if over MAX_ENTRIES.
 */
export async function appendExperience(projectDir: string, text: string): Promise<void> {
  const path = experienceLogPath(projectDir);
  const date = new Date().toISOString().split('T')[0];
  const entry = `- [${date}] ${text.trim()}`;

  let existing: string[] = [];
  try {
    const content = readFileSync(path, 'utf-8');
    existing = content.split('\n').filter(line => ENTRY_RE.test(line));
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Dedup: skip if identical entry already exists
  if (existing.includes(entry)) return;

  existing.push(entry);

  // FIFO eviction
  if (existing.length > MAX_ENTRIES) {
    existing = existing.slice(existing.length - MAX_ENTRIES);
  }

  const output = `# Experience Log\n\n${existing.join('\n')}\n`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, output, 'utf-8');
}

/**
 * Read the experience log as markdown. Returns '' if absent.
 * Synchronous — called during prompt build.
 *
 * Process-cached and char-capped (2026-04-19). Previously read from disk
 * every prompt build; now cached until file mtime changes. Output capped
 * at MAX_RETURN_CHARS so a runaway log can't bloat the cached prefix.
 */
const MAX_RETURN_CHARS = 1600; // ~400 tokens
const cache = new Map<string, { mtimeMs: number; value: string }>();

export function readExperienceLog(projectDir: string): string {
  const path = experienceLogPath(projectDir);
  try {
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;

    const content = readFileSync(path, 'utf-8');
    const entries = content.split('\n').filter(line => ENTRY_RE.test(line));
    if (entries.length === 0) {
      cache.set(path, { mtimeMs: stat.mtimeMs, value: '' });
      return '';
    }

    // Most-recent first, char-capped
    const reversed = [...entries].reverse();
    let result = '';
    for (const entry of reversed) {
      if (result.length + entry.length + 1 > MAX_RETURN_CHARS) break;
      result = result ? `${result}\n${entry}` : entry;
    }
    cache.set(path, { mtimeMs: stat.mtimeMs, value: result });
    return result;
  } catch {
    return '';
  }
}
