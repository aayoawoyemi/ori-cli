/**
 * TS-side helpers for the compose sub-loop scratch substrate.
 *
 * The body owns the per-request scratch markdown lifecycle (body/scratch.py).
 * This module provides:
 *   - sweepOrphanScratches: TS-side cleanup for files older than max-age.
 *     Mirrors body/scratch.py:sweep_orphan_scratches but runs at CLI startup
 *     (no body process needed) so it catches scratch files left over from
 *     prior sessions that crashed.
 *
 * Path layout matches the body convention:
 *   <project>/.aries/tmp/requests/<session_id>-<request_id>.md
 */
import { join } from 'node:path';
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';

/**
 * Delete request-scratch markdown files older than maxAgeHours.
 *
 * Returns the count of files deleted. Failures (permission, transient IO)
 * are swallowed silently — sweeping is best-effort. The caller should not
 * block on the return value.
 */
export function sweepOrphanScratches(projectRoot: string, maxAgeHours: number = 24): number {
  const dir = join(projectRoot, '.aries', 'tmp', 'requests');
  if (!existsSync(dir)) return 0;
  const cutoffMs = Date.now() - maxAgeHours * 3600 * 1000;
  let deleted = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = join(dir, name);
    try {
      const stat = statSync(full);
      if (stat.mtimeMs < cutoffMs) {
        unlinkSync(full);
        deleted += 1;
      }
    } catch {
      // ignore — file may have been deleted between readdir and stat
    }
  }
  return deleted;
}
