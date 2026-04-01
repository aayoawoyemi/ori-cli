import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface VaultNote {
  title: string;
  score?: number;
  source?: string; // 'ranked' | 'warmth' | 'important'
  signals?: Record<string, number>;
}

export interface VaultStatus {
  vaultRoot: string;
  noteCount: number;
  inboxCount: number;
  orphanCount: number;
}

export interface VaultIdentity {
  identity: string | null;
  goals: string | null;
  userModel: string | null;
  methodology: string | null;
}

// ── MCP JSON-RPC Client ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
  }>();

  async connect(vaultPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn('ori', ['serve', '--mcp', '--vault', vaultPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: true, // Required on Windows to resolve .cmd shims
      });

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        // Ori logs to stderr — ignore unless it's a fatal error
        const msg = chunk.toString();
        if (msg.includes('Error') || msg.includes('FATAL')) {
          this.emit('error', new Error(msg));
        }
      });

      this.proc.on('error', (err) => {
        reject(new Error(`Failed to start ori MCP server: ${err.message}`));
      });

      this.proc.on('exit', (code) => {
        // Reject all pending requests
        for (const [, p] of this.pending) {
          p.reject(new Error(`MCP server exited with code ${code}`));
        }
        this.pending.clear();
        this.proc = null;
      });

      // Send initialize handshake
      this.call('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'aries-cli', version: '0.1.0' },
      }).then(() => {
        // Send initialized notification
        this.notify('notifications/initialized', {});
        resolve();
      }).catch(reject);
    });
  }

  private processBuffer(): void {
    // Try both newline-delimited JSON (Ori's format) and Content-Length framing
    while (this.buffer.length > 0) {
      // Check for Content-Length framing first
      if (this.buffer.startsWith('Content-Length:')) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;

        const header = this.buffer.slice(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        if (this.buffer.length < bodyStart + contentLength) break;

        const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
        this.buffer = this.buffer.slice(bodyStart + contentLength);
        this.handleJsonMessage(body);
        continue;
      }

      // Newline-delimited JSON (Ori's default)
      const newlineIdx = this.buffer.indexOf('\n');
      if (newlineIdx === -1) break; // incomplete line

      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length > 0) {
        this.handleJsonMessage(line);
      }
    }
  }

  private handleJsonMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as JsonRpcResponse;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    } catch {
      // Malformed JSON — skip
    }
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) throw new Error('MCP client not connected');

    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const body = JSON.stringify(request) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(body);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP call timed out: ${method}`));
        }
      }, 30_000);
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    const body = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.proc.stdin!.write(body);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.call('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text: string }>;
    };
    if (result?.content?.[0]?.text) {
      return JSON.parse(result.content[0].text);
    }
    return result;
  }

  disconnect(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}

// ── Vault Interface ─────────────────────────────────────────────────────────

export class OriVault {
  private client: McpClient;
  private _vaultPath: string;
  private _connected = false;

  constructor(vaultPath: string) {
    this._vaultPath = vaultPath;
    this.client = new McpClient();
  }

  get vaultPath(): string { return this._vaultPath; }
  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    await this.client.connect(this._vaultPath);
    this._connected = true;
  }

  disconnect(): void {
    this.client.disconnect();
    this._connected = false;
  }

  // ── Retrieval ───────────────────────────────────────────────────────────

  async queryRanked(query: string, limit = 5): Promise<VaultNote[]> {
    try {
      const result = await this.client.callTool('ori_query_ranked', {
        query, limit, include_archived: false,
      }) as { success: boolean; data?: { results: Array<{ title: string; score: number; signals?: Record<string, number> }> } };

      return (result.data?.results ?? []).map(r => ({
        title: r.title,
        score: r.score,
        source: 'ranked',
        signals: r.signals,
      }));
    } catch {
      return [];
    }
  }

  async queryWarmth(context: string, limit = 3): Promise<VaultNote[]> {
    try {
      const result = await this.client.callTool('ori_warmth', {
        context, limit,
      }) as { success: boolean; data?: { results: Array<{ title: string; score: number; source: string }> } };

      return (result.data?.results ?? []).map(r => ({
        title: r.title,
        score: r.score,
        source: 'warmth',
      }));
    } catch {
      return [];
    }
  }

  async queryImportant(limit = 2): Promise<VaultNote[]> {
    try {
      const result = await this.client.callTool('ori_query_important', {
        limit,
      }) as { success: boolean; data?: { results: Array<{ title: string; score: number }> } };

      return (result.data?.results ?? []).map(r => ({
        title: r.title,
        score: r.score,
        source: 'important',
      }));
    } catch {
      return [];
    }
  }

  async explore(query: string, limit = 10, depth = 2): Promise<VaultNote[]> {
    try {
      const result = await this.client.callTool('ori_explore', {
        query, limit, depth, include_content: false,
      }) as { success: boolean; data?: { results: Array<{ title: string; score: number }> } };

      return (result.data?.results ?? []).map(r => ({
        title: r.title,
        score: r.score,
        source: 'explore',
      }));
    } catch {
      return [];
    }
  }

  // ── Write ───────────────────────────────────────────────────────────────

  async add(title: string, content: string, type = 'insight'): Promise<boolean> {
    try {
      const result = await this.client.callTool('ori_add', {
        title, content, type,
      }) as { success: boolean };
      return result.success;
    } catch {
      return false;
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  async status(): Promise<VaultStatus | null> {
    try {
      const result = await this.client.callTool('ori_status', {}) as {
        success: boolean;
        data?: VaultStatus;
      };
      return result.data ?? null;
    } catch {
      return null;
    }
  }

  // ── Identity ────────────────────────────────────────────────────────────

  async loadIdentity(): Promise<VaultIdentity> {
    const selfPath = join(this._vaultPath, 'self');
    const read = (file: string): string | null => {
      const p = join(selfPath, file);
      if (existsSync(p)) {
        try { return readFileSync(p, 'utf-8'); } catch { return null; }
      }
      return null;
    };

    return {
      identity: read('identity.md'),
      goals: read('goals.md'),
      userModel: read('user-model.md'),
      methodology: read('methodology.md'),
    };
  }

  // ── Orient ──────────────────────────────────────────────────────────────

  async orient(): Promise<unknown> {
    try {
      return await this.client.callTool('ori_orient', { brief: true });
    } catch {
      return null;
    }
  }

  // ── Update self files ───────────────────────────────────────────────────

  async updateSelfFile(file: 'identity' | 'goals' | 'methodology', content: string): Promise<boolean> {
    try {
      const result = await this.client.callTool('ori_update', {
        file, content,
      }) as { success: boolean };
      return result.success;
    } catch {
      return false;
    }
  }
}

// ── Vault Discovery ─────────────────────────────────────────────────────────

/** Find an Ori vault by checking common locations. */
export function findVault(configPath?: string): string | null {
  // 1. Explicit config path
  if (configPath && existsSync(join(configPath, '.ori'))) {
    return configPath;
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';

  // 2. Known vault locations first (these are intentional vaults, not caches)
  const candidates = [
    join(home, 'brain'),
    join(home, '.aries', 'vault'),
    join(home, '.ori-memory'),
  ];
  for (const c of candidates) {
    // A real vault has .ori AND at least a notes/ or self/ directory
    if (existsSync(join(c, '.ori')) && (existsSync(join(c, 'notes')) || existsSync(join(c, 'self')))) {
      return c;
    }
  }

  // 3. Walk up from cwd (but require notes/ or self/ to distinguish from caches)
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, '.ori')) && (existsSync(join(dir, 'notes')) || existsSync(join(dir, 'self')))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}
