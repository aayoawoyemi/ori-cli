import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────────────

export type SessionEntry =
  | { type: 'meta'; model: string; vault: string | null; cwd: string; agentName: string; timestamp: number }
  | { type: 'user'; content: string; timestamp: number }
  | { type: 'assistant'; content: string; timestamp: number }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; timestamp: number }
  | { type: 'tool_result'; id: string; name: string; output: string; isError: boolean; timestamp: number }
  | { type: 'code_execution'; code: string; stdout: string; stderr: string; exception: string | null; duration_ms: number; rejected: { reason: string } | null; timed_out: boolean; rlm_stats?: { call_count: number; total_tokens: number }; timestamp: number }
  | { type: 'preflight'; projectNotes: string[]; vaultNotes: string[]; timestamp: number }
  | { type: 'postflight'; importance: number; reflected: boolean; timestamp: number }
  | { type: 'compact_boundary'; summary: string; insightsSaved: number; pruneOnly: boolean; timestamp: number }
  | { type: 'error'; message: string; timestamp: number };

// ── Session Storage ─────────────────────────────────────────────────────────

export class SessionStorage {
  private filePath: string;
  private sessionDir: string;
  readonly sessionId: string;

  constructor(cwd: string) {
    // Sessions stored at ~/.aries/sessions/<project-hash>/
    const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 12);
    this.sessionDir = join(homedir(), '.aries', 'sessions', projectHash);
    mkdirSync(this.sessionDir, { recursive: true });

    // Current session file — timestamped
    this.sessionId = Date.now().toString(36);
    this.filePath = join(this.sessionDir, `${this.sessionId}.jsonl`);
  }

  /** Get the session file path. */
  get path(): string { return this.filePath; }

  /** Get the session directory (for listing past sessions). */
  get dir(): string { return this.sessionDir; }

  /** Append an entry to the session log. */
  log(entry: SessionEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.filePath, line, 'utf-8');
    } catch {
      // Session logging should never crash the agent
    }
  }

  /** Read all entries from a session file. */
  static readSession(filePath: string): SessionEntry[] {
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line) as SessionEntry);
    } catch {
      return [];
    }
  }

  /** List all session files for this project, sorted by most recent. */
  listSessions(): { path: string; timestamp: number }[] {
    if (!existsSync(this.sessionDir)) return [];
    try {
      const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
      return readdirSync(this.sessionDir)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => {
          const p = join(this.sessionDir, f);
          return { path: p, timestamp: statSync(p).mtimeMs };
        })
        .sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  /** Get the most recent session file (excluding current). */
  getLastSession(): string | null {
    const sessions = this.listSessions();
    // Skip current session, return the previous one
    const previous = sessions.find(s => s.path !== this.filePath);
    return previous?.path ?? null;
  }
}
