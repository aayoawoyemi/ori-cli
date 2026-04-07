import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
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
  | { type: 'interrupted'; reason: string; timestamp: number }
  | { type: 'error'; message: string; timestamp: number };

export interface SessionMeta {
  id: string;
  title: string | null;
  userTitle: string | null;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  model: string;
  cwd: string;
  costEstimate: number;
}

// ── Session Index ──────────────────────────────────────────────────────────

function indexPath(sessionDir: string): string {
  return join(sessionDir, 'sessions.json');
}

function readIndex(sessionDir: string): SessionMeta[] {
  const p = indexPath(sessionDir);
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SessionMeta[];
  } catch {
    return [];
  }
}

function writeIndex(sessionDir: string, index: SessionMeta[]): void {
  try {
    writeFileSync(indexPath(sessionDir), JSON.stringify(index, null, 2), 'utf-8');
  } catch {
    // Index write should never crash the agent
  }
}

// ── Session Storage ─────────────────────────────────────────────────────────

export class SessionStorage {
  private filePath: string;
  private sessionDir: string;
  readonly sessionId: string;
  readonly cwd: string;
  private logCount = 0;

  constructor(cwd: string) {
    this.cwd = cwd;
    const projectHash = createHash('md5').update(cwd).digest('hex').slice(0, 12);
    this.sessionDir = join(homedir(), '.aries', 'sessions', projectHash);
    mkdirSync(this.sessionDir, { recursive: true });

    this.sessionId = Date.now().toString(36);
    this.filePath = join(this.sessionDir, `${this.sessionId}.jsonl`);
  }

  get path(): string { return this.filePath; }
  get dir(): string { return this.sessionDir; }

  log(entry: SessionEntry): void {
    try {
      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.filePath, line, 'utf-8');
      this.logCount++;
      // Flush index on early entries (meta at 1, user at ~2) and every 20 logs
      // so interrupted sessions are always visible in the session list
      if (this.logCount <= 5 || this.logCount % 20 === 0) {
        this.touch(this.logCount);
      }
    } catch {
      // Session logging should never crash the agent
    }
  }

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

  // ── Metadata Index ───────────────────────────────────────────────────

  createMeta(model: string, sessionName?: string): void {
    const index = readIndex(this.sessionDir);
    const meta: SessionMeta = {
      id: this.sessionId,
      title: null,
      userTitle: sessionName ?? null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      model,
      cwd: this.cwd,
      costEstimate: 0,
    };
    index.unshift(meta);
    writeIndex(this.sessionDir, index);
  }

  updateMeta(patch: Partial<Pick<SessionMeta, 'title' | 'userTitle' | 'lastActiveAt' | 'messageCount' | 'costEstimate'>>): void {
    const index = readIndex(this.sessionDir);
    const entry = index.find(s => s.id === this.sessionId);
    if (!entry) return;
    if (patch.title !== undefined) entry.title = patch.title;
    if (patch.userTitle !== undefined) entry.userTitle = patch.userTitle;
    if (patch.lastActiveAt !== undefined) entry.lastActiveAt = patch.lastActiveAt;
    if (patch.messageCount !== undefined) entry.messageCount = patch.messageCount;
    if (patch.costEstimate !== undefined) entry.costEstimate = patch.costEstimate;
    writeIndex(this.sessionDir, index);
  }

  setTitle(title: string): void {
    this.updateMeta({ title });
  }

  rename(userTitle: string): void {
    this.updateMeta({ userTitle });
  }

  touch(messageCount: number, costEstimate?: number): void {
    this.updateMeta({
      lastActiveAt: Date.now(),
      messageCount,
      ...(costEstimate !== undefined ? { costEstimate } : {}),
    });
  }

  // ── Listing ──────────────────────────────────────────────────────────

  listSessions(): SessionMeta[] {
    const index = readIndex(this.sessionDir);
    if (index.length > 0) {
      // Merge index with any orphaned JSONL files not in the index
      const indexedIds = new Set(index.map(s => s.id));
      const orphaned = this.scanLegacySessions().filter(s => !indexedIds.has(s.id));
      const merged = [...index, ...orphaned]
        .filter(s => s.id !== this.sessionId)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
      return merged;
    }
    // Fallback: scan JSONL files if no index exists (legacy sessions)
    return this.scanLegacySessions();
  }

  getLastSession(): SessionMeta | null {
    const sessions = this.listSessions();
    return sessions[0] ?? null;
  }

  getSessionPath(id: string): string {
    return join(this.sessionDir, `${id}.jsonl`);
  }

  findSession(query: string): SessionMeta | null {
    const sessions = this.listSessions();
    // Try exact ID match
    const byId = sessions.find(s => s.id === query);
    if (byId) return byId;
    // Try numeric index (1-based)
    const num = parseInt(query, 10);
    if (!isNaN(num) && num >= 1 && num <= sessions.length) {
      return sessions[num - 1]!;
    }
    // Fuzzy title match
    const lower = query.toLowerCase();
    return sessions.find(s =>
      (s.userTitle ?? s.title ?? '')
        .toLowerCase()
        .includes(lower)
    ) ?? null;
  }

  private scanLegacySessions(): SessionMeta[] {
    if (!existsSync(this.sessionDir)) return [];
    try {
      return readdirSync(this.sessionDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const p = join(this.sessionDir, f);
          const id = basename(f, '.jsonl');
          if (id === this.sessionId) return null;
          const stat = statSync(p);
          // Peek at the first line for meta info
          let model = 'unknown';
          let cwd = this.cwd;
          try {
            const firstLine = readFileSync(p, 'utf-8').split('\n')[0];
            if (firstLine) {
              const entry = JSON.parse(firstLine);
              if (entry.type === 'meta') {
                model = entry.model ?? model;
                cwd = entry.cwd ?? cwd;
              }
            }
          } catch { /* ignore */ }
          return {
            id,
            title: null,
            userTitle: null,
            createdAt: stat.birthtimeMs,
            lastActiveAt: stat.mtimeMs,
            messageCount: 0,
            model,
            cwd,
            costEstimate: 0,
          } as SessionMeta;
        })
        .filter((s): s is SessionMeta => s !== null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch {
      return [];
    }
  }
}
