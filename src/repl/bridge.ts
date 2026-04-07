/**
 * High-level REPL bridge — JSON-RPC protocol + request queue + restart-on-crash.
 *
 * Usage:
 *   const bridge = new ReplBridge({ onEvent: (e) => console.log(e) });
 *   await bridge.start();
 *   const result = await bridge.exec({ code: "print('hello')" });
 *   await bridge.shutdown();
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplProcess } from './process.js';
import type {
  CodeExecution,
  ReplResult,
  ReplEvent,
  ReplOptions,
  IndexRequest,
  IndexResult,
  CodebaseStats,
  CodebaseSignature,
  VaultConnectRequest,
  VaultConnectResult,
  VaultStatus,
  VaultSignature,
  RlmConfigRequest,
  RlmConfigResult,
  SignatureLevel,
} from './types.js';
import type { OriVault } from '../memory/vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default server path: <repo>/body/server.py
const DEFAULT_SERVER = resolve(__dirname, '../../body/server.py');
const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

type PendingResolver = (result: any) => void;

export class ReplBridge {
  private process: ReplProcess | null = null;
  private pending: PendingResolver[] = [];
  private restarting = false;
  private restartCount = 0;
  private vault: OriVault | null = null;

  private opts: {
    serverPath: string;
    pythonCmd: string;
    timeoutMs: number;
    maxRestarts: number;
    onEvent?: (e: ReplEvent) => void;
    onRestart?: () => Promise<void>;
  };

  constructor(options: ReplOptions = {}) {
    this.opts = {
      serverPath: options.serverPath ?? DEFAULT_SERVER,
      pythonCmd: options.pythonCmd ?? DEFAULT_PYTHON,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRestarts: options.maxRestarts ?? 3,
      onEvent: options.onEvent,
      onRestart: options.onRestart,
    };
  }

  private emit(e: ReplEvent): void {
    this.opts.onEvent?.(e);
  }

  private drainPendingAsError(reason: string, code: number | null): void {
    const queue = this.pending;
    this.pending = [];
    for (const r of queue) {
      r({ error: reason, exit_code: code });
    }
  }

  private createProcess(): ReplProcess {
    return new ReplProcess({
      pythonCmd: this.opts.pythonCmd,
      serverPath: this.opts.serverPath,
      onLine: (line) => {
        try {
          const msg = JSON.parse(line);

          // Vault callback: Python proxy needs vault data during exec
          if (msg.vault_request) {
            this.handleVaultCallback(msg.vault_request);
            return; // Don't resolve pending — exec is still running
          }

          // Normal response — resolve pending request
          const resolver = this.pending.shift();
          if (resolver) resolver(msg);
        } catch {
          const resolver = this.pending.shift();
          if (resolver) resolver({ error: `bad json from body: ${line.slice(0, 160)}` });
        }
      },
      onExit: (code, signal) => {
        // Flush any pending requests as errors so callers aren't stuck
        this.drainPendingAsError(`python body exited`, code);
        if (!this.restarting) {
          this.emit({
            type: 'bridge_error',
            error: `python body exited code=${code} signal=${signal}`,
          });
        }
      },
      onStderr: (line) => {
        // Surface python stderr on host stderr (low volume, diagnostic)
        if (!line.includes('[body] ready')) {
          process.stderr.write(`[body] ${line}\n`);
        }
      },
    });
  }

  async start(): Promise<void> {
    if (this.process?.isAlive()) return;
    this.process = this.createProcess();
    await this.process.start();
    this.emit({ type: 'bridge_ready' });
  }

  private async restart(reason: string): Promise<void> {
    if (this.restarting) return;
    if (this.restartCount >= this.opts.maxRestarts) {
      this.emit({
        type: 'bridge_error',
        error: `max restarts (${this.opts.maxRestarts}) exceeded: ${reason}`,
      });
      throw new Error(`bridge max restarts exceeded: ${reason}`);
    }

    this.restarting = true;
    this.restartCount++;
    this.emit({ type: 'bridge_restart', reason, attempt: this.restartCount });

    try {
      if (this.process?.isAlive()) {
        await this.process.shutdown(500);
      }
      this.process = this.createProcess();
      await this.process.start();
      this.emit({ type: 'bridge_ready' });
      // Re-initialize: re-index codebase, reconnect vault, reconfigure rlm
      if (this.opts.onRestart) {
        try {
          await this.opts.onRestart();
        } catch (err) {
          this.emit({
            type: 'bridge_error',
            error: `post-restart re-init failed: ${(err as Error).message}`,
          });
        }
      }
    } finally {
      this.restarting = false;
    }
  }

  private async request(msg: object, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    // Ensure process is alive
    if (!this.process?.isAlive()) {
      await this.restart('process not alive at request time');
    }

    return new Promise((resolveReq, rejectReq) => {
      let settled = false;

      const resolver: PendingResolver = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolveReq(result);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const idx = this.pending.indexOf(resolver);
        if (idx >= 0) this.pending.splice(idx, 1);
        rejectReq(new DOMException('The operation was aborted.', 'AbortError'));
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        // Remove from pending queue if still there
        const idx = this.pending.indexOf(resolver);
        if (idx >= 0) this.pending.splice(idx, 1);
        rejectReq(new Error(`bridge request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Listen for abort before pushing to queue
      if (signal?.aborted) {
        rejectReq(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.push(resolver);
      const ok = this.process!.write(JSON.stringify(msg));
      if (!ok) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const idx = this.pending.indexOf(resolver);
        if (idx >= 0) this.pending.splice(idx, 1);
        rejectReq(new Error('bridge write failed (stdin unwritable)'));
      }
    });
  }

  /**
   * Verify the body is responsive. Cheap. Use for health checks.
   */
  async ping(): Promise<boolean> {
    try {
      const r = await this.request({ op: 'ping' }, 5_000);
      return r.pong === true;
    } catch {
      return false;
    }
  }

  /**
   * Execute user code in the REPL body. Returns structured result.
   */
  async exec(execution: CodeExecution, signal?: AbortSignal): Promise<ReplResult> {
    this.emit({
      type: 'exec_start',
      code: execution.code,
      turn_id: execution.turn_id,
    });

    const timeout = execution.timeout_ms ?? this.opts.timeoutMs;
    const result = (await this.request(
      {
        op: 'exec',
        code: execution.code,
        timeout_ms: timeout,
      },
      // Give the body extra wall-clock slack beyond its own timeout
      timeout + 5_000,
      signal,
    )) as ReplResult;

    this.emit({ type: 'exec_end', result, turn_id: execution.turn_id });
    return result;
  }

  /**
   * Reset the REPL namespace (clears any user-added state).
   */
  async reset(): Promise<boolean> {
    const r = await this.request({ op: 'reset' }, 5_000);
    return r.ok === true;
  }

  /**
   * Index a repository into the body's codebase graph.
   * After this call, `codebase` is available in the REPL namespace.
   */
  async index(req: IndexRequest): Promise<IndexResult> {
    return this.request(
      {
        op: 'index',
        repo_path: req.repoPath,
        include_exts: req.includeExts,
        exclude_dirs: req.excludeDirs,
      },
      60_000, // indexing can take a while for large repos
    );
  }

  /**
   * Get stats about the currently-loaded codebase graph.
   */
  async codebaseStats(): Promise<CodebaseStats | { error: string }> {
    return this.request({ op: 'codebase_stats' }, 5_000);
  }

  /**
   * Re-parse specific files from disk and update the codebase graph in-place.
   * Call after Edit/Write to keep the graph current.
   */
  async refreshFiles(paths: string[], rootDir: string): Promise<{ refreshed?: string[]; errors?: string[]; error?: string }> {
    return this.request({ op: 'refresh_files', paths, root_dir: rootDir }, 10_000);
  }

  /**
   * Compile the codebase ambient signature — structural summary ready to be
   * used as stable prefix in model context.
   *
   * @param level content density: lean | standard | deep | max
   * @param maxTokens hard cap; progressive trimming below this.
   */
  async codebaseSignature(
    level: SignatureLevel = 'standard',
    maxTokens: number = 1500,
  ): Promise<CodebaseSignature> {
    return this.request(
      { op: 'codebase_signature', level, max_tokens: maxTokens },
      10_000,
    );
  }

  /**
   * Compile the vault ambient signature — identity + pinned context ready
   * to be used as stable prefix in model context.
   */
  async vaultSignature(
    level: SignatureLevel = 'standard',
    maxTokens: number = 1500,
  ): Promise<VaultSignature> {
    return this.request(
      { op: 'vault_signature', level, max_tokens: maxTokens },
      10_000,
    );
  }

  /**
   * Connect the body to an Ori vault. After this call, `vault` is available
   * in the REPL namespace.
   */
  async connectVault(req: VaultConnectRequest): Promise<VaultConnectResult> {
    return this.request(
      { op: 'connect_vault', vault_path: req.vaultPath },
      20_000,
    );
  }

  /**
   * Disconnect the vault from the body.
   */
  async disconnectVault(): Promise<{ ok: boolean }> {
    return this.request({ op: 'disconnect_vault' }, 5_000);
  }

  /**
   * Get vault status (note count, inbox count, orphans).
   */
  async vaultStatus(): Promise<VaultStatus> {
    return this.request({ op: 'vault_status' }, 5_000);
  }

  /**
   * Configure rlm_call / rlm_batch with Anthropic credentials.
   * After this call, rlm_call and rlm_batch are exposed in the REPL namespace.
   */
  async configureRlm(req: RlmConfigRequest): Promise<RlmConfigResult> {
    return this.request(
      {
        op: 'configure_rlm',
        api_key: req.apiKey,
        model: req.model,
        max_calls: req.maxCalls,
      },
      5_000,
    );
  }

  /**
   * Graceful shutdown. Sends shutdown op, waits, then SIGKILL if needed.
   */
  async shutdown(): Promise<void> {
    if (!this.process) return;
    await this.process.shutdown(2_000);
    this.process = null;
  }

  isAlive(): boolean {
    return this.process?.isAlive() ?? false;
  }

  getRestartCount(): number {
    return this.restartCount;
  }

  /**
   * Give the bridge a reference to the TS-side vault so it can handle
   * vault_request callbacks from the Python proxy during exec.
   */
  setVault(vault: OriVault | null): void {
    this.vault = vault;
  }

  /**
   * Handle a vault_request from Python: call the TS-owned Ori MCP,
   * send the result back to Python stdin as vault_response.
   */
  private async handleVaultCallback(req: { id: number; method: string; args: Record<string, unknown> }): Promise<void> {
    let result: unknown = null;
    try {
      if (!this.vault?.connected) throw new Error('vault not connected');
      result = await this.vault.callTool(req.method, req.args);
    } catch (err) {
      result = { success: false, error: (err as Error).message };
    }

    // Send response back to Python's stdin
    this.process?.write(JSON.stringify({
      vault_response: { id: req.id, result },
    }));
  }
}
