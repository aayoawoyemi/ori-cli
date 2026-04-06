/**
 * Trajectory logger for REPL executions.
 *
 * Writes one JSONL line per exec to .aries/repl-traces/<session-id>.jsonl.
 * Becomes training data later (Phases 4+, when rlm_call trajectories
 * contain full sub-call breakdowns).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ReplResult, CodeExecution } from './types.js';

export interface TrajectoryEntry {
  timestamp: string;
  turn_id?: string;
  code: string;
  stdout: string;
  stderr: string;
  exception: string | null;
  duration_ms: number;
  rejected: { reason: string } | null;
  timed_out: boolean;
  rlm_stats?: ReplResult['rlm_stats'];
}

export class TrajectoryLogger {
  private path: string;
  private initialized = false;

  constructor(logPath: string) {
    this.path = resolve(logPath);
  }

  private ensureDir(): void {
    if (this.initialized) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.initialized = true;
    } catch {
      // best-effort — logging failures should not break the bridge
    }
  }

  log(execution: CodeExecution, result: ReplResult): void {
    this.ensureDir();
    const entry: TrajectoryEntry = {
      timestamp: new Date().toISOString(),
      turn_id: execution.turn_id,
      code: execution.code,
      stdout: result.stdout,
      stderr: result.stderr,
      exception: result.exception,
      duration_ms: result.duration_ms,
      rejected: result.rejected,
      timed_out: result.timed_out,
      rlm_stats: result.rlm_stats,
    };
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf-8');
    } catch {
      // best-effort
    }
  }
}

/**
 * Compute default trace path: <project>/.aries/repl-traces/<timestamp>.jsonl
 */
export function defaultTrajectoryPath(cwd: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(cwd, '.aries', 'repl-traces', `${ts}.jsonl`);
}
