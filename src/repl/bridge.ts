/**
 * High-level REPL bridge — JSON-RPC protocol + request queue + restart-on-crash.
 *
 * Usage:
 *   const bridge = new ReplBridge({ onEvent: (e) => console.log(e) });
 *   await bridge.start();
 *   const result = await bridge.exec({ code: "print('hello')" });
 *   await bridge.shutdown();
 */
import { resolve, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { ReplProcess } from './process.js';
import { fuzzyFind, generateDiff } from '../tools/edit.js';
import { captureSnapshot } from '../tools/snapshot.js';
import { WebFetchTool } from '../tools/webFetch.js';
import { WebSearchTool } from '../tools/webSearch.js';
import type { WebSearchConfig } from '../config/types.js';
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
  ResearchConnectResult,
} from './types.js';
// OriVault needs a value import (not type-only) because Fix 1B auto-creates
// a project vault inline via `new OriVault(path)` in ensureProjectVault.
// initVault is the scaffolding helper that invokes `ori init` as a subprocess.
import { OriVault, initVault } from '../memory/vault.js';
import type { ModelRouter } from '../router/index.js';
import { discover } from '../research/discover.js';
import { ingestSources } from '../research/ingest.js';
import { extractFromSource } from '../research/extract.js';
import { readSource, readSources } from '../research/read.js';
import { plan } from '../research/plan.js';
import { synthesize } from '../research/synthesize.js';
import { fetchUrl } from '../research/fetchUrl.js';
import { saveSession, loadSession, listSessions } from '../research/artifacts.js';
import { Budget, DEPTH_BUDGETS } from '../research/budget.js';
import type { DiscoveredSource, IngestedSource, Finding, SynthesisReport, SessionMeta, ResearchSession, ResearchEvent, ResearchPlan } from '../research/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Default server path: <repo>/body/server.py
const DEFAULT_SERVER = resolve(__dirname, '../../body/server.py');
const DEFAULT_PYTHON = process.platform === 'win32' ? 'python' : 'python3';

type PendingResolver = (result: any) => void;

// ── Web search output parser ─────────────────────────────────────────────────
// WebSearchTool produces a flat string (one block per result, separated by
// blank lines) because it targets the tool-schema contract where ToolResult.
// output is a single string. Inside codemode, web.search's Python contract
// is list[dict] — structured data the model can iterate over. We parse back
// here instead of forking the tool.
//
// Block shape produced by every backend (tavily/brave/serper/serpapi/ddg):
//   Answer: <text>              ← optional, only when backend has an answer box
//                                  (blank line after)
//   <title>
//   <url>
//   <snippet may span multiple lines>
//                                  (blank line before next block)

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  answer?: string;  // only on the first result when the backend surfaced one
}

function parseWebSearchOutput(output: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  let answer: string | undefined;

  // Extract the answer line if present (it always leads the output).
  let body = output;
  const answerMatch = body.match(/^Answer:\s*(.+?)\n\n/s);
  if (answerMatch) {
    answer = answerMatch[1]!.trim();
    body = body.slice(answerMatch[0].length);
  }

  // Each block: 3+ lines separated by blank line(s). First line = title,
  // second = url, rest = snippet (may span multiple lines).
  const blocks = body.split(/\n\s*\n/).filter(b => b.trim());
  for (const block of blocks) {
    if (results.length >= maxResults) break;
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;  // need at least title + url
    const title = lines[0]!;
    const url = lines[1]!;
    const snippet = lines.slice(2).join(' ');
    results.push({ title, url, snippet });
  }

  // Attach the answer to the first result so the model sees them together.
  // A dedicated `answer` top-level key would be cleaner, but the docstring
  // in body/web.py already says "first dict may have answer" — keep that
  // contract for now.
  if (answer && results.length > 0) {
    results[0]!.answer = answer;
  } else if (answer && results.length === 0) {
    // Pure answer-box case — no organic results. Surface as a synthetic entry.
    results.push({ title: '(answer)', url: '', snippet: answer, answer });
  }

  return results;
}

// ── Bridge-side vault projection (v0.5 Phase 1, 2026-04-21) ──────────────
//
// Strips decoration fields from vault_response payloads before they reach
// the Python proxy. Six weeks of REPL telemetry (53 trace files) showed
// the model never reads `signals`, `spaces`, `rrf`, `composite`, warmth
// internals, or federation markers — but each retrieval call was paying
// 2–6K tokens to ship them. Grep confirmed no aries-cli code consumes
// them either (they were internal state that leaked onto the wire).
//
// Keep this shape-aware: retrieval methods return `{results: [...]}` and
// need per-result projection; non-retrieval methods (orient, status, add,
// ori_query for backlinks/orphans/dangling) have heterogeneous shapes and
// pass through untouched.
//
// Becomes redundant once Ori MCP ships the trim at source in v0.6.0.
// Gate behind signature.trimVaultReturns (default true) so a single
// config flip restores the raw shape if anything downstream breaks.

const RETRIEVAL_METHODS = new Set([
  'ori_query_ranked',
  'ori_query_similar',
  'ori_warmth',
  'ori_query_important',
  'ori_query_fading',
  'ori_explore',
]);

const RESULT_STRIP_KEYS = [
  'signals', 'spaces', 'rrf', 'rrf_base', 'composite',
  'pprScore', 'seedScore', 'warmthScore',
  '_federated', '_vault', '_sources',
];

const ENVELOPE_STRIP_KEYS = ['_federated', '_vault', '_sources'];

interface VaultEnvelope {
  success?: boolean;
  data?: { results?: unknown[]; warmth?: Record<string, unknown>; [k: string]: unknown };
  results?: unknown[];
  warmth?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Project a vault MCP response to the minimal shape the model actually
 * reads. Returns [projected, bytesStripped]. Non-retrieval methods pass
 * through untouched (the byte count is 0).
 *
 * Retrieval shape preserved: `{success, data: {results: [{title, path,
 * score, snippet}], ...kept envelope fields}}`. Everything on
 * RESULT_STRIP_KEYS is removed per-result; warmth.candidates/promoted/
 * demoted and ENVELOPE_STRIP_KEYS are removed envelope-wide.
 */
export function projectVaultResult(
  method: string,
  result: unknown,
): { projected: unknown; bytesStripped: number } {
  // Non-retrieval methods — pass through. Orient/status/add use
  // heterogeneous shapes that we don't want to accidentally mutilate.
  if (!RETRIEVAL_METHODS.has(method)) {
    return { projected: result, bytesStripped: 0 };
  }
  if (!result || typeof result !== 'object') {
    return { projected: result, bytesStripped: 0 };
  }

  const originalBytes = JSON.stringify(result).length;

  // ori-memory uniformly wraps payloads as `{success, data: {...}}`.
  // Occasionally older paths return data inline at the top level — handle
  // both by finding whichever layer actually carries `results[]`.
  const env = result as VaultEnvelope;
  const dataLayer = (env.data && typeof env.data === 'object') ? env.data : env;

  // Project each result item by copying only fields NOT on the strip list.
  // Preserves whatever legitimate fields (title, path, score, snippet,
  // type, description, etc.) the server actually sends, without hard-
  // coding a whitelist that drifts if ori adds new useful fields.
  const results = Array.isArray(dataLayer.results) ? dataLayer.results : null;
  if (results) {
    const projectedResults = results.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const entry = item as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (!RESULT_STRIP_KEYS.includes(k)) out[k] = v;
      }
      return out;
    });
    dataLayer.results = projectedResults;
  }

  // Warmth debug envelope — `candidates/promoted/demoted` are reranker
  // diagnostics (which notes moved rank, by how much). Useful for
  // ori_recent debug surfaces (coming in v0.6.0), not useful per-call.
  const warmth = dataLayer.warmth;
  if (warmth && typeof warmth === 'object') {
    const w = warmth as Record<string, unknown>;
    delete w.candidates;
    delete w.promoted;
    delete w.demoted;
  }

  // Envelope-level federation decoration. The routing/merge trace was
  // already logged to stderr during federateRetrieval; the wire payload
  // should not re-carry it.
  for (const k of ENVELOPE_STRIP_KEYS) {
    delete (dataLayer as Record<string, unknown>)[k];
    delete (env as Record<string, unknown>)[k];
  }

  const finalBytes = JSON.stringify(result).length;
  return { projected: result, bytesStripped: Math.max(0, originalBytes - finalBytes) };
}

export class ReplBridge {
  private process: ReplProcess | null = null;
  private pending: PendingResolver[] = [];
  // Batch 3.5 (2026-04-25) — serialize top-level TS→body requests.
  //
  // The body can run `exec` in a worker while its main loop stays free to
  // route callback responses (`vault_response`, `fs_response`, `ask_response`,
  // etc.). That only works if the TS side does NOT send a second top-level
  // request (ping/signature/status/index/another exec) while the first exec is
  // still pending. If it does, body/server.py's FIFO-preserving join path can
  // block the main loop, so callback responses sit unread and the Repl call
  // eventually dies at `timeout + 30s` (the observed 120s walkmode failure).
  //
  // This promise chain is the narrow invariant: top-level request/response
  // traffic remains FIFO, while callback responses continue to bypass the
  // queue via direct process.write() calls in resolveAsk/handle*Callback.
  private requestTail: Promise<void> = Promise.resolve();
  private restarting = false;
  private restartCount = 0;
  private vault: OriVault | null = null;
  // Project-local vault (Fix 1B — project-layered). Independent OriVault
  // pointed at <project>/.ori/. null when no project vault exists yet or
  // we're in vault-only mode (cwd == global vault). Connected by setup.ts
  // via setProjectVault, or auto-created on first scope="project" add via
  // handleVaultCallback's auto-init branch. Note: this is a SECOND
  // ori-memory MCP subprocess. The two vaults don't share any state —
  // warmth, Q-value, graph signals all live per-vault. Federation happens
  // at the bridge layer on retrieval (see routeVaultMethod).
  private projectVault: OriVault | null = null;
  private router: ModelRouter | null = null;
  private researchOutputDir: string | null = null;
  // Workspace root used by fs.* callbacks to scope writes. Defaults to the
  // process cwd but setup.ts should always override via setCwd(opts.cwd) —
  // the Aries harness may be invoked from a directory other than the user's
  // actual workspace, and fs.write's boundary check has to match the project
  // the user thinks they're in. Never trust the default in production.
  private cwd: string = process.cwd();
  // Web search provider config. Passed in via setWebSearchConfig from setup.ts
  // when AriesConfig.webSearch is set. When unset, WebSearchTool still works
  // via env vars (TAVILY_API_KEY etc) or falls back to DDG. Holding it here
  // so web.search callbacks construct WebSearchTool with the right provider.
  private webSearchConfig: WebSearchConfig = {};
  // Server-side handle store: ingest() returns opaque handles; full sources live here
  private researchHandles: Map<string, IngestedSource> = new Map();
  // Callback fired when research.save() completes — used by app.tsx to exit research mode.
  private onResearchSaved: ((dir: string) => void) | null = null;
  // Session budget — persists across dispatchResearchMethod calls within the same /research run.
  private researchBudget: Budget | null = null;
  // UI-facing handlers for say/ask. Registered directly by app.tsx via
  // setOnSay/setOnAsk (mirrors setOnResearchSaved). Kept on a separate
  // channel from general onEvent because:
  //   1. say/ask are UI concerns, not logging concerns — index.ts's general
  //      onEvent shouldn't need to know about them.
  //   2. ask must route to a specific UI modal that can call resolveAsk —
  //      there's only ever ONE consumer, not many observers.
  // If no handler is registered, say() is a no-op visually (text is silently
  // dropped) and ask() will time out on the Python side after its timeout.
  private onSay: ((text: string) => void) | null = null;
  private onAsk: ((id: number, question: string) => void) | null = null;
  // Gate for bridge-side vault response trim. Default true — Phase 1 of
  // v0.5 strips decoration on the wire. Setup.ts reads AriesConfig's
  // signature.trimVaultReturns and calls setTrimVaultReturns(...) to
  // honor user override.
  private trimVaultReturns: boolean = true;

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
      // Default 90s (bumped from 30s 2026-04-21, v0.5 Phase 1.5). vault.explore
      // can take 30-60s server-side; the prior default guaranteed timeouts on
      // cold spreading-activation walks. See defaults.ts repl.timeoutMs comment.
      timeoutMs: options.timeoutMs ?? 90_000,
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
      // Body cwd must match the harness workspace root so relative-path
      // reads inside Python resolve to the same place fs.edit's workspace
      // gate computes against. this.cwd is already the authoritative
      // value — populated via setCwd() from setup.ts (opts.cwd). If the
      // restart path fires before setCwd has been called (theoretically
      // possible during very early failures), `this.cwd` falls back to
      // process.cwd() as initialized on line 133 — same behavior as
      // before this change, just now made explicit rather than implicit.
      cwd: this.cwd,
      onLine: (line) => {
        try {
          const msg = JSON.parse(line);

          // Vault callback: Python proxy needs vault data during exec
          if (msg.vault_request) {
            this.handleVaultCallback(msg.vault_request);
            return; // Don't resolve pending — exec is still running
          }

          // Research callback: Python research proxy needs TS to dispatch the op
          if (msg.research_request) {
            this.handleResearchCallback(msg.research_request);
            return; // Don't resolve pending — exec is still running
          }

          // Fs callback: Python fs proxy needs TS to perform a workspace-scoped
          // write/edit/patch. Same non-resolving pattern as vault/research —
          // the exec thread is blocked in Fs._call() waiting for fs_response.
          if (msg.fs_request) {
            this.handleFsCallback(msg.fs_request);
            return;
          }

          // Shell callback: Python shell proxy needs TS to run a command.
          // Same non-resolving pattern — exec thread blocks in Shell._call()
          // for the duration of the shell command (up to its timeout + 10s).
          if (msg.shell_request) {
            this.handleShellCallback(msg.shell_request);
            return;
          }

          // Web callback: web.fetch / web.search delegate to the existing
          // WebFetchTool / WebSearchTool. Same non-resolving pattern.
          if (msg.web_request) {
            this.handleWebCallback(msg.web_request);
            return;
          }

          // Say notification: fire-and-forget from Python. No response is
          // written back, exec is NOT blocked, and pending is NOT resolved.
          // We just surface the text to the registered UI handler (if any)
          // and to the general onEvent stream (so debug loggers see it).
          // The emit is wrapped in try-catch inside dispatchSay — a flaky
          // UI handler must never propagate back and kill the bridge.
          if (msg.say) {
            this.dispatchSay(msg.say);
            return;
          }

          // Ask callback: Python is blocked in Speak._call on a threading.Event
          // waiting for ask_response. We fire the registered UI handler with
          // (id, question) and trust the UI to eventually call resolveAsk(id,
          // answer), which writes ask_response back to Python's stdin. If no
          // handler is registered, the Python side will time out per its own
          // timeout (default 300s) — same failure mode as a user who never
          // clicks the modal. Same non-resolving pattern as vault/fs.
          if (msg.ask_request) {
            this.handleAskCallback(msg.ask_request);
            return;
          }

          // Done sentinel: Python called done(value). Fire-and-forget from
          // the bridge's perspective — no response is written back, pending
          // is NOT resolved, exec continues. The value ALSO arrives in the
          // final exec result (body/server.py harvests the _done_sink
          // buffer in _run_exec), so the bridge emission here is purely a
          // real-time observability channel for UI / telemetry subscribers.
          // Same non-resolving pattern as say / ask_request.
          if (msg.done) {
            this.dispatchDone(msg.done);
            return;
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
    const previous = this.requestTail;
    let release!: () => void;
    this.requestTail = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });

    await previous.catch(() => undefined);
    try {
      return await this.requestUnlocked(msg, timeoutMs, signal);
    } finally {
      release();
    }
  }

  private async requestUnlocked(msg: object, timeoutMs: number, signal?: AbortSignal): Promise<any> {
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
   * Send environment metadata to the body for the first-turn banner.
   *
   * Fires once per body lifetime (including after a restart — onRestart
   * in setup.ts re-sends). Before A10 these facts lived in four separate
   * places (setCwd for the workspace gate, the indexer op for codebase,
   * the connect_vault op for vault, nothing at all for shell) and were
   * never surfaced to the model. The banner lied by omission. Now: one
   * op, five fields, straight to the banner's display globals on the
   * Python side. See body/server.py `configure` handler and the
   * PROJECT/VAULT_GLOBAL/... block for the receiving end.
   *
   * This op is display-only. It does NOT gate writes, select vaults,
   * or steer indexing — those stay in their own ops. Separation matters
   * because restart recovery replays specific ops; bundling them would
   * make partial-failure recovery harder.
   */
  async configure(cfg: {
    project?: string;
    vaultGlobal?: string;
    vaultProject?: string | null;
    mode?: 'project+vault' | 'vault-only';
    shell?: string;
  }): Promise<void> {
    await this.request({
      op: 'configure',
      project: cfg.project ?? null,
      vault_global: cfg.vaultGlobal ?? null,
      vault_project: cfg.vaultProject ?? null,
      mode: cfg.mode ?? null,
      shell: cfg.shell ?? null,
    }, 5_000);
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
      // Give the body extra wall-clock slack beyond its own timeout.
      //
      // Bumped 5s → 30s in Batch 2 (A.6.6, 2026-04). The walk-codemode
      // trace surfaced a 95s bridge timeout; Batch 2's 100-trial repro
      // (scripts/done_hang_repro.py) failed to reproduce the stdout-lock
      // deadlock hypothesis (0 hangs), which makes slow body-side cleanup
      // the more plausible cause — `repl.execute` already does a best-
      // effort `t.join(timeout=1.0)` after `_async_raise(TimeoutError)`,
      // but a daemon thread lingering past that join for a few seconds
      // while finishing a stdout.flush() is still possible and would
      // blow the 5s slack budget. 30s is defensive without sacrificing
      // fail-fast on a genuinely wedged body (still far below wall-clock
      // patience for any real task).
      timeout + 30_000,
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
      30_000,
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
      30_000,
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
        base_url: req.baseUrl,
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
   * Give the bridge a reference to the project-local vault (Fix 1B).
   * Independent OriVault instance pointing at <project>/.ori/. Optional —
   * when null, project-scoped vault ops return an error (or, on ori_add,
   * trigger the auto-create path in handleVaultCallback).
   */
  setProjectVault(vault: OriVault | null): void {
    this.projectVault = vault;
  }

  /** Read-only accessor for the current project vault (for banner/config sync). */
  getProjectVault(): OriVault | null {
    return this.projectVault;
  }

  /**
   * Give the bridge the model router so research callbacks can call
   * extractFromSource and synthesize (which need cheapCall).
   */
  setRouter(router: ModelRouter | null): void {
    this.router = router;
  }

  /**
   * Set the output directory for research session persistence.
   * Defaults to process.cwd() if not set.
   */
  setResearchOutputDir(dir: string): void {
    this.researchOutputDir = dir;
  }

  /**
   * Set the workspace root used by fs.* callbacks to bound writes. Must be
   * the directory the user considers "the project" — setup.ts passes
   * opts.cwd here. Until this is called, the bridge uses process.cwd()
   * which is often wrong when Aries is launched from elsewhere.
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Set the web-search provider config so web.search callbacks know which
   * backend (Tavily/Brave/Serper/SerpAPI) to use. Without this, WebSearchTool
   * falls back to env-var resolution then DDG — still functional, just worse.
   */
  setWebSearchConfig(cfg: WebSearchConfig): void {
    this.webSearchConfig = cfg;
  }

  /**
   * Register a callback that fires after research.save() persists an artifact.
   * Used by the UI to auto-exit research mode back to the pre-research permission mode.
   */
  setOnResearchSaved(cb: ((dir: string) => void) | null): void {
    this.onResearchSaved = cb;
  }

  /**
   * Register the UI handler for say(text) calls from the Python body.
   * The handler should append text to the user-visible assistant message
   * stream. If no handler is registered, say() output is silently dropped
   * — which is the correct behavior for headless benchmark runs that
   * don't have a UI to render to.
   */
  setOnSay(cb: ((text: string) => void) | null): void {
    this.onSay = cb;
  }

  /**
   * Register the UI handler for ask(question) calls from the Python body.
   * The handler must eventually call bridge.resolveAsk(id, answer) to
   * unblock the Python side, or ask() will time out per its configured
   * timeout (default 300s in body/speak.py). If no handler is registered,
   * every ask() call times out — again correct for headless runs.
   */
  setOnAsk(cb: ((id: number, question: string) => void) | null): void {
    this.onAsk = cb;
  }

  /**
   * Unblock a pending ask() call by sending ask_response back to Python.
   * Called by the UI after the user submits (or cancels — pass '' on cancel)
   * the modal. Safe to call with a stale id (Python has already timed out
   * and dropped the pending entry) — SPEAK.resolve is a no-op in that case.
   *
   * The response shape matches body/speak.py's expectation:
   * result.answer (string) is returned to the model; result.error (string)
   * would raise AskError on the Python side.
   */
  resolveAsk(id: number, answer: string): void {
    this.process?.write(JSON.stringify({
      ask_response: { id, result: { answer } },
    }));
  }

  /**
   * Set a session-level token budget for research.extract / research.synthesize.
   * Called by app.tsx when /research is invoked, sized by --depth.
   * Pass null to clear.
   */
  setResearchBudget(maxTokens: number | null): void {
    this.researchBudget = maxTokens && maxTokens > 0 ? new Budget(maxTokens) : null;
  }

  /** Current research budget snapshot (or null if not set). */
  getResearchBudgetStatus(): { max: number; spent: number; remaining: number } | null {
    return this.researchBudget?.toJSON() ?? null;
  }

  /**
   * Tell the Python body to connect its research proxy.
   * After this, `research` is available in the REPL namespace.
   */
  async connectResearch(): Promise<ResearchConnectResult> {
    return this.request({ op: 'connect_research' }, 20_000);
  }

  /**
   * Handle a vault_request from Python: dispatch to the correct vault
   * (global / project / both merged) based on args.scope, then send the
   * result back to Python stdin as vault_response.
   *
   * Scope semantics (Fix 1B — project-layered vaults):
   *   - "global"  : route to this.vault (the ~/brain MCP). Used for
   *                 cross-project identity/research notes.
   *   - "project" : route to this.projectVault (the <cwd>/.ori/ MCP).
   *                 On ori_add with no project vault connected, auto-
   *                 scaffold .ori/ in this.cwd and connect before
   *                 forwarding the call. This matches the "first add
   *                 creates the vault" UX the user chose.
   *   - "both"    : retrieval-only. Query both vaults in parallel, merge
   *                 results by score, de-dup on (title, path), truncate
   *                 to the original `limit`. Non-retrieval methods with
   *                 scope="both" fall back to global (writes need a
   *                 single target).
   *   - absent    : defaults come from body/vault.py's per-method
   *                 signature. If Python ever omits scope entirely, the
   *                 fallback here is "global" so the old behavior is
   *                 preserved for legacy callers.
   *
   * The scope arg is STRIPPED from args before forwarding to the MCP —
   * ori-memory's MCP tools don't know about scope, they just know what
   * vault they're pointed at. We route; they work.
   */
  private async handleVaultCallback(req: { id: number; method: string; args: Record<string, unknown> }): Promise<void> {
    let result: unknown = null;
    try {
      // Extract and strip scope from args — MCP tools don't expect it.
      const scope = (req.args.scope as string | undefined) ?? 'global';
      const cleanArgs = { ...req.args };
      delete cleanArgs.scope;

      result = await this.routeVaultMethod(req.method, cleanArgs, scope);
    } catch (err) {
      result = { success: false, error: (err as Error).message };
    }

    // Phase 1 projection: strip decoration before the Python proxy sees
    // it. Stderr byte-count log serves as the one-session validation
    // signal — if any downstream consumer depended on a stripped field
    // we'll see it break with this log line still printing. See
    // projectVaultResult for the list of stripped keys.
    if (this.trimVaultReturns) {
      const { projected, bytesStripped } = projectVaultResult(req.method, result);
      result = projected;
      if (bytesStripped > 0) {
        process.stderr.write(`[trim] ${req.method} stripped ${bytesStripped}B\n`);
      }
    }

    // Send response back to Python's stdin
    this.process?.write(JSON.stringify({
      vault_response: { id: req.id, result },
    }));
  }

  /**
   * Toggle bridge-side vault response trim (Phase 1 of v0.5). setup.ts
   * calls this with AriesConfig's signature.trimVaultReturns on bridge
   * init. Default is true; flip to false if you need raw MCP payloads.
   */
  setTrimVaultReturns(enabled: boolean): void {
    this.trimVaultReturns = enabled;
  }

  /**
   * Internal dispatch for vault methods by scope. Kept separate from
   * handleVaultCallback so the scope logic is unit-testable without the
   * JSON-RPC plumbing. See handleVaultCallback's header for scope
   * semantics.
   */
  private async routeVaultMethod(
    method: string,
    args: Record<string, unknown>,
    scope: string,
  ): Promise<unknown> {
    if (scope === 'global') {
      if (!this.vault?.connected) throw new Error('vault not connected');
      return this.vault.callTool(method, args);
    }

    if (scope === 'project') {
      // Auto-create path: only on ori_add. Reads against a non-existent
      // project vault should fail loud ("no project vault to read from")
      // rather than silently auto-scaffold — we don't want the model
      // creating empty vaults during exploratory queries.
      if (!this.projectVault?.connected) {
        if (method === 'ori_add') {
          const created = await this.ensureProjectVault();
          if (!created) {
            throw new Error(
              'project vault auto-create failed. Either run `ori init` in this directory manually, or use scope="global".'
            );
          }
        } else {
          throw new Error(
            `no project vault at ${this.cwd}. ori_add with scope="project" will create one automatically; for ${method} you need a vault that already exists.`
          );
        }
      }
      // At this point projectVault is guaranteed connected.
      return this.projectVault!.callTool(method, args);
    }

    if (scope === 'both') {
      // Short-circuit: if there's nothing to federate with, skip the
      // fan-out. In vault-only mode (cwd == vault) projectVault is
      // intentionally null, so every scope="both" retrieval would
      // otherwise run federateRetrieval which does a Promise.all against
      // a null side and emits federation telemetry for a degenerate
      // one-vault case. Route directly to the global vault instead.
      // Correctness-equivalent, noise-free, one less async hop per call.
      if (!this.projectVault?.connected) {
        if (!this.vault?.connected) throw new Error('no vaults connected');
        return this.vault.callTool(method, args);
      }
      return this.federateRetrieval(method, args);
    }

    throw new Error(`unknown vault scope: ${scope}. Valid values: "global", "project", "both".`);
  }

  /**
   * Create a project vault at this.cwd and connect it. Called by
   * routeVaultMethod's auto-init path on first scope="project" ori_add.
   *
   * Three-step sequence: scaffold via ori-memory init → instantiate
   * OriVault pointing at the new path → connect (spawns the MCP). All
   * three must succeed; any failure leaves this.projectVault null so a
   * subsequent retry sees a clean slate. We do NOT leave a half-
   * scaffolded .ori/ directory on connect failure — ori-memory init is
   * idempotent, so re-running it doesn't duplicate work.
   */
  private async ensureProjectVault(): Promise<boolean> {
    try {
      const ok = await initVault(this.cwd);
      if (!ok) return false;
      const pv = new OriVault(this.cwd);
      await pv.connect();
      this.projectVault = pv;
      return true;
    } catch (err) {
      this.opts.onEvent?.({
        type: 'bridge_error',
        error: `project vault auto-create exception: ${(err as Error).message}`,
      });
      return false;
    }
  }

  /**
   * Fan-out retrieval across both vaults, merge, re-rank, de-dup,
   * truncate. The default path for scope="both" on any retrieval method.
   *
   * Merge strategy (simple, defensible):
   *   1. Call both vaults with the SAME limit — we want enough headroom
   *      from each side that the merged top-N has something to pick
   *      from. This doubles the MCP load per retrieval but remains
   *      bounded.
   *   2. Concatenate result arrays. If a vault returned an error
   *      envelope (success: false), skip its contribution rather than
   *      fail the whole query — partial results beat no results.
   *   3. De-dup on (title, path) so a note that happens to exist in
   *      both vaults only surfaces once, under whichever score is
   *      higher.
   *   4. Sort descending by score.
   *   5. Truncate to the original `limit`.
   *
   * Score comparability caveat: each vault computes scores
   * independently (its own warmth, Q-values, graph signals). Cross-
   * vault comparisons are approximate. The merged result is "here are
   * the best candidates from both places" not "globally ranked by a
   * unified metric." Good enough for first-cut project-layered usage;
   * proper cross-vault normalization is deferred.
   */
  private async federateRetrieval(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // If neither vault is connected, surface an error rather than an
    // empty success (the model can tell the difference and it matters).
    if (!this.vault?.connected && !this.projectVault?.connected) {
      throw new Error('no vaults connected — cannot perform scope="both" retrieval');
    }

    const limit = typeof args.limit === 'number' ? args.limit : 10;

    // Fire both calls in parallel. Catch per-call so one bad vault
    // doesn't poison the merged result.
    const [gRes, pRes] = await Promise.all([
      this.vault?.connected
        ? this.vault.callTool(method, args).catch((e: Error) => ({ success: false, error: e.message }))
        : Promise.resolve(null),
      this.projectVault?.connected
        ? this.projectVault.callTool(method, args).catch((e: Error) => ({ success: false, error: e.message }))
        : Promise.resolve(null),
    ]);

    // Normalize each side to a results array. MCP payloads come back
    // as {success, data: {results: [...]}} (envelope) OR {results: [...]}
    // (already unwrapped). callTool does the JSON.parse but NOT the
    // envelope unwrap — that's the Python side's _unwrap_data. Here we
    // handle both shapes so federation works regardless.
    //
    // Note on the _vault tag: this used to be merged into each result
    // dict as `_vault: "global" | "project"` so the model could see which
    // side a result came from. A10 proved that was a net-negative design
    // choice — the extra field was shape-surprise bait that caused the
    // model to probe the return instead of composing. We now collect the
    // provenance here, log it for bridge-side telemetry (see
    // federation_trace event below), and STRIP it before the payload
    // leaves. Same rule for the envelope's _federated / _sources fields:
    // telemetry-only, never in the model's view. See the vault note
    // "predictable-apis-over-prose-rails-always" for the principle.
    const extractResults = (raw: unknown): Array<Record<string, unknown>> => {
      if (!raw || typeof raw !== 'object') return [];
      const obj = raw as Record<string, unknown>;
      if (obj.success === false) return [];
      const payload = (obj.data ?? obj) as Record<string, unknown>;
      const arr = payload.results;
      if (!Array.isArray(arr)) return [];
      return arr as Array<Record<string, unknown>>;
    };

    const globalResults = extractResults(gRes);
    const projectResults = extractResults(pRes);

    // De-dup: same (title, path) from both vaults keeps the higher
    // score. Uses a Map keyed on the compound identifier. We remember
    // which side won the tie so provenance logging below is accurate.
    // The Map value pairs the result with its source vault tag; the
    // tag is dropped before the payload leaves.
    type Tagged = { result: Record<string, unknown>; source: 'global' | 'project' };
    const dedup = new Map<string, Tagged>();
    const push = (arr: Array<Record<string, unknown>>, source: 'global' | 'project') => {
      for (const r of arr) {
        const key = `${r.title ?? ''}|${r.path ?? ''}`;
        const existing = dedup.get(key);
        const rScore = typeof r.score === 'number' ? r.score : 0;
        const eScore = existing && typeof existing.result.score === 'number'
          ? (existing.result.score as number) : 0;
        if (!existing || rScore > eScore) {
          dedup.set(key, { result: r, source });
        }
      }
    };
    push(globalResults, 'global');
    push(projectResults, 'project');

    const mergedTagged = Array.from(dedup.values())
      .sort((a, b) => {
        const sa = typeof a.result.score === 'number' ? a.result.score : 0;
        const sb = typeof b.result.score === 'number' ? b.result.score : 0;
        return sb - sa;
      })
      .slice(0, limit);

    // Telemetry BEFORE stripping. Logs federation provenance (counts per
    // side, which-side-won-dedup per row) so the bridge-side debug trail
    // captures what used to live on the payload itself. A future refactor
    // that drops this logging will show up as silence in debug output —
    // a visible failure mode — rather than telemetry evaporating unseen.
    // Deliberate: this is the canonical place for federation provenance;
    // do not re-introduce the `_federated`/`_vault`/`_sources` fields on
    // the payload just to make inline debugging easier.
    //
    // Sink is stderr rather than onEvent because onEvent currently routes
    // to the TUI's event channel, which renders every message to the user.
    // Federation trace is informational, not a bridge_error — a user
    // running `ori` shouldn't see "[repl] bridge_error: federation_trace:
    // ..." in their TUI on every vault retrieval. Stderr gets captured in
    // log files / redirects without polluting the interactive surface.
    // If we later add a proper "bridge_trace" event type with a quiet
    // default renderer, migrate this write there — but NOT to bridge_error.
    process.stderr.write(
      `[federation_trace] method=${method} sources={global:${globalResults.length}, project:${projectResults.length}} returned=${mergedTagged.length} winners=${JSON.stringify(mergedTagged.map(t => ({ title: t.result.title, source: t.source })))}\n`
    );

    const merged = mergedTagged.map(t => t.result);

    // Shape the return to match single-vault retrieval shape so the
    // Python side's _unwrap_data is happy AND the model sees the exact
    // same envelope it sees for scope="global" or scope="project". A10
    // learning: any decoration that varies between scope variants is
    // shape-surprise bait. Keep the envelope uniform.
    return {
      success: true,
      data: {
        results: merged,
      },
    };
  }

  /**
   * Handle a research_request from Python: dispatch to the appropriate
   * TS research stage function, then send research_response back to Python.
   */
  private async handleResearchCallback(
    req: { id: number; method: string; args: Record<string, unknown> },
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.dispatchResearchMethod(req.method, req.args);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.process?.write(JSON.stringify({
      research_response: { id: req.id, result },
    }));
  }

  private async dispatchResearchMethod(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'plan': {
        if (!this.router) throw new Error('router not set — call setRouter() before research.plan()');
        const query = args.query as string;
        const knownContext = (args.knownContext as string | undefined) ?? undefined;
        const emit = this.makeResearchEmitter();
        return plan(query, this.router, this.researchBudget ?? undefined, knownContext, emit);
      }

      case 'read': {
        if (!this.router) throw new Error('router not set — call setRouter() before research.read()');
        const rawSource = args.source;
        const researchPlan = args.plan as ResearchPlan | undefined;
        let source: IngestedSource;
        if (typeof rawSource === 'string') {
          const s = this.researchHandles.get(rawSource);
          if (!s) throw new Error(`handle not found: ${rawSource}`);
          source = s;
        } else {
          source = rawSource as IngestedSource;
        }
        const emit = this.makeResearchEmitter();
        // If no plan provided, create a minimal one
        const fallbackPlan: ResearchPlan = researchPlan ?? {
          researchQuestion: args.query as string ?? source.title,
          queries: [{ query: source.title, targetApis: [source.sourceApi], rationale: 'Direct read', priority: 'essential' }],
          activeApis: [source.sourceApi],
          relevanceCriteria: source.title,
          estimatedDepth: 1,
        };
        return readSource(source, this.router, fallbackPlan, this.researchBudget ?? undefined, undefined, emit);
      }

      case 'discover': {
        const query = args.query as string;
        const limit = (args.limit as number | undefined) ?? 30;
        const seeds = args.seeds as DiscoveredSource[] | undefined;
        const emit = this.makeResearchEmitter();
        return discover(query, limit, seeds, { budget: this.researchBudget ?? undefined, onError: (msg) => emit({ type: 'error', phase: 'discover', message: msg }) });
      }

      case 'ingest': {
        const sources = args.sources as DiscoveredSource[];
        const fetchFn = this.makeFetchFn();
        const emit = this.makeResearchEmitter();
        const query = (args.query as string | undefined) ?? undefined;
        const ingested = await ingestSources(sources, fetchFn, query, emit);
        // Store full sources server-side; return slim handle metadata to Python.
        // This keeps bridge payloads well under 100KB even for large papers.
        return ingested.map(s => {
          const handle = `${s.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          this.researchHandles.set(handle, s);
          return {
            id: s.id,
            title: s.title,
            url: s.url,
            sourceApi: s.sourceApi,
            sections_count: s.sections.length,
            fulltext_len: s.fullText.length,
            handle,
          };
        });
      }

      case 'load': {
        const handle = args.handle as string;
        const field = (args.field as string | undefined) ?? 'sections';
        const source = this.researchHandles.get(handle);
        if (!source) throw new Error(`handle not found: ${handle}`);
        if (field === 'sections') return source.sections;
        if (field === 'fullText') return source.fullText;
        if (field === 'references') return source.references;
        throw new Error(`unknown field: ${field}`);
      }

      case 'fetch': {
        // Targeted URL drill-down: replaces WebFetch inside research mode.
        const url = args.url as string;
        if (!url || typeof url !== 'string') throw new Error('fetch requires a url string');
        const focus = (args.focus as string | undefined) || undefined;
        const title = (args.title as string | undefined) || undefined;
        const fetchFnForFetch = this.makeFetchFn();
        const source = await fetchUrl(url, fetchFnForFetch, { focus, title });
        // Register in the handle store so research.extract(handle) works.
        const handle = `${source.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this.researchHandles.set(handle, source);
        return {
          id: source.id,
          title: source.title,
          url: source.url,
          sourceApi: source.sourceApi,
          sections_count: source.sections.length,
          fulltext_len: source.fullText.length,
          handle,
        };
      }

      case 'extract': {
        if (!this.router) throw new Error('router not set — call setRouter() before research.extract()');
        const rawSource = args.source;
        const focus = (args.focus as string | undefined) || undefined;
        let source: IngestedSource;
        if (typeof rawSource === 'string') {
          // handle string
          const s = this.researchHandles.get(rawSource);
          if (!s) throw new Error(`handle not found: ${rawSource}`);
          source = s;
        } else {
          source = rawSource as IngestedSource;
        }
        const emit = this.makeResearchEmitter();
        return extractFromSource(source, this.router, { focus, budget: this.researchBudget ?? undefined, onError: (msg) => emit({ type: 'error', phase: 'extract', message: msg }) });
      }

      case 'synthesize': {
        if (!this.router) throw new Error('router not set — call setRouter() before research.synthesize()');
        const findings = args.findings as Finding[];
        const query = args.query as string;
        const emit = this.makeResearchEmitter();
        return synthesize(query, findings, 'standard', findings.length, findings.length, 0, this.router, this.researchBudget ?? undefined, emit);
      }

      case 'budget_status': {
        return this.getResearchBudgetStatus() ?? { max: 0, spent: 0, remaining: 0 };
      }

      case 'budget_set': {
        const max = args.max_tokens as number | null;
        this.setResearchBudget(max ?? null);
        return this.getResearchBudgetStatus();
      }

      case 'session': {
        const slug = args.slug as string;
        const outputDir = this.researchOutputDir ?? process.cwd();
        const existing = loadSession(outputDir, slug);
        if (existing) return existing;
        // New empty session
        return {
          meta: {
            slug, query: slug, depth: 'standard',
            date: new Date().toISOString(),
            sourcesDiscovered: 0, sourcesIngested: 0, findingsCount: 0,
            convergentCount: 0, contradictionCount: 0, gapCount: 0,
          } satisfies SessionMeta,
          sources: [] as DiscoveredSource[],
          findings: [] as Finding[],
          graph: { nodes: [], edges: [] },
          frontier: [] as string[],
        };
      }

      case 'save': {
        const sessionData = args.session as Record<string, unknown>;
        const outputDir = this.researchOutputDir ?? process.cwd();
        const findings = (sessionData.findings as Finding[]) ?? [];
        // Reconstruct a minimal SynthesisReport if not present
        const report: SynthesisReport = (sessionData.report as SynthesisReport) ?? {
          query: (sessionData.meta as SessionMeta)?.query ?? '',
          depth: (sessionData.meta as SessionMeta)?.depth ?? 'standard',
          sourcesDiscovered: (sessionData.meta as SessionMeta)?.sourcesDiscovered ?? 0,
          sourcesIngested: (sessionData.meta as SessionMeta)?.sourcesIngested ?? 0,
          findingsExtracted: findings.length,
          citationsChasedDepth: 0,
          convergent: [], contradictions: [], gaps: [], findings, frontier: [],
        };
        // Stamp current budget into the session meta if one exists.
        const meta = { ...(sessionData.meta as SessionMeta) };
        const budgetSnap = this.researchBudget?.toJSON();
        if (budgetSnap) {
          meta.budget = budgetSnap;
        }
        const session: ResearchSession = {
          meta,
          report,
          sources: (sessionData.sources as DiscoveredSource[]) ?? [],
          findings,
          graph: (sessionData.graph as ResearchSession['graph']) ?? { nodes: [], edges: [] },
          frontier: (sessionData.frontier as string[]) ?? [],
          reflectionQueries: [],
        };
        const dir = saveSession(session, outputDir);
        // Notify UI (app.tsx) so it can exit research mode automatically.
        try {
          this.onResearchSaved?.(dir);
        } catch {
          // never let UI callback errors break the save RPC
        }
        return { ok: true, dir };
      }

      case 'list_sessions': {
        const outputDir = this.researchOutputDir ?? process.cwd();
        return listSessions(outputDir);
      }

      default:
        throw new Error(`unknown research method: ${method}`);
    }
  }

  // ── Fs callback handler ──────────────────────────────────────────────────
  // Handles fs_request messages from body/fs.py. Each handler method writes
  // fs_response back to Python stdin exactly once, whether the call succeeded
  // or failed. If we forget to write a response, the Python proxy blocks on
  // threading.Event forever and the entire exec hangs. That's why every path
  // through handleFsCallback ends in this.process?.write({fs_response}).

  /**
   * Route fs_request from Python to the appropriate TS-side operation.
   * Catches any thrown error and surfaces it as `{error: string}` in the
   * response — Python's Fs._call lifts that into an FsError exception the
   * model code can catch with try/except.
   */
  private async handleFsCallback(
    req: { id: number; method: string; args: Record<string, unknown> },
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.dispatchFsMethod(req.method, req.args);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.process?.write(JSON.stringify({
      fs_response: { id: req.id, result },
    }));
  }

  /**
   * Dispatch write/edit/patch fs operations.
   *
   * Workspace-scope gate: the resolved path must live inside this.cwd. We
   * resolve first, then check `startsWith(this.cwd)` on the normalized path.
   * Anything outside the workspace returns an error asking the model to
   * use ask() for approval — this is the A1 minimum-viable permission flow
   * per CODEMODE_ROADMAP.md. A follow-up phase wires onPermissionRequest
   * through to allow prompt-based approval of external writes.
   *
   * All three methods (write/edit/patch) call captureSnapshot so the Aries
   * undo/history system sees the change. Matches the top-level EditTool
   * and WriteTool exactly — fs.edit from inside the Repl must produce the
   * same side effects as the top-level Edit tool, because the point of
   * codemode is that the model can't tell (and shouldn't care) whether
   * a capability lives in the namespace or in a tool schema.
   */
  private async dispatchFsMethod(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'write': {
        // Full file write. Overwrites. Creates parent dirs. Matches WriteTool.execute.
        const rawPath = args.path as string;
        const content = args.content as string;
        if (!rawPath || typeof rawPath !== 'string') {
          throw new Error('fs.write: path required (string)');
        }
        if (typeof content !== 'string') {
          throw new Error('fs.write: content required (string)');
        }
        const absPath = resolve(this.cwd, rawPath);
        this.assertInsideWorkspace(absPath, 'fs.write');

        mkdirSync(dirname(absPath), { recursive: true });
        // Use 'Write' as the snapshot tool label — functionally identical to
        // the top-level WriteTool, undo treats them the same. If we ever
        // want to distinguish fs.* from tool-level writes in the undo UI,
        // widen FileSnapshot.tool in snapshot.ts first.
        captureSnapshot(absPath, 'Write');
        writeFileSync(absPath, content, 'utf-8');
        return {
          ok: true,
          path: absPath,
          bytes: Buffer.byteLength(content, 'utf-8'),
        };
      }

      case 'edit': {
        // Single-pair find/replace via the shared fuzzyFind strategy list.
        const rawPath = args.path as string;
        const oldString = args.old as string;
        const newString = args.new as string;
        const replaceAll = (args.replace_all as boolean) ?? false;
        if (!rawPath || typeof oldString !== 'string' || typeof newString !== 'string') {
          throw new Error('fs.edit: path, old, new required');
        }
        const absPath = resolve(this.cwd, rawPath);
        this.assertInsideWorkspace(absPath, 'fs.edit');

        const content = readFileSync(absPath, 'utf-8');
        const found = fuzzyFind(content, oldString);
        if (!found) {
          throw new Error(`fs.edit: old not found in ${absPath} (tried all fuzzy strategies)`);
        }

        // Uniqueness check — refuse ambiguous edits unless replace_all is set.
        // Same semantics as EditTool: protects against sweeping changes the
        // model didn't intend.
        if (!replaceAll) {
          const count = content.split(found.match).length - 1;
          if (count > 1) {
            throw new Error(
              `fs.edit: match appears ${count} times in ${absPath}. Pass replace_all=True or include more context in old.`
            );
          }
        }

        const updated = replaceAll
          ? content.split(found.match).join(newString)
          : content.replace(found.match, newString);

        captureSnapshot(absPath, 'Edit');
        writeFileSync(absPath, updated, 'utf-8');
        const diff = generateDiff(found.match, newString, absPath);
        return {
          ok: true,
          path: absPath,
          diff,
          strategy: found.strategy,
        };
      }

      case 'patch': {
        // Batched edits — N (old, new) pairs in one round-trip. Each edit
        // applies to the result of the previous. Saves bridge round-trips
        // and (once wired) saves N-1 permission prompts.
        const rawPath = args.path as string;
        const edits = args.edits as Array<[string, string]>;
        const replaceAll = (args.replace_all as boolean) ?? false;
        if (!rawPath || !Array.isArray(edits) || edits.length === 0) {
          throw new Error('fs.patch: path and non-empty edits array required');
        }
        const absPath = resolve(this.cwd, rawPath);
        this.assertInsideWorkspace(absPath, 'fs.patch');

        let working = readFileSync(absPath, 'utf-8');
        const original = working;
        let applied = 0;

        for (let i = 0; i < edits.length; i++) {
          const pair = edits[i]!;
          const [oldStr, newStr] = pair;
          const found = fuzzyFind(working, oldStr);
          if (!found) {
            throw new Error(
              `fs.patch: edit ${i + 1}/${edits.length} — old not found. ${applied} edits already applied in-memory, none persisted.`
            );
          }
          if (!replaceAll) {
            const count = working.split(found.match).length - 1;
            if (count > 1) {
              throw new Error(
                `fs.patch: edit ${i + 1}/${edits.length} — match appears ${count} times. Pass replace_all=True or narrow.`
              );
            }
          }
          working = replaceAll
            ? working.split(found.match).join(newStr)
            : working.replace(found.match, newStr);
          applied++;
        }

        // fs.patch is a series of edits, so 'Edit' is the correct label.
        captureSnapshot(absPath, 'Edit');
        writeFileSync(absPath, working, 'utf-8');
        return {
          ok: true,
          path: absPath,
          applied,
          diff: generateDiff(original, working, absPath),
        };
      }

      default:
        throw new Error(`unknown fs method: ${method}`);
    }
  }

  // ── Shell callback handler ───────────────────────────────────────────────
  // Handles shell_request messages from body/shell.py. The model's
  // `shell.run("npm test")` call arrives here, runs via spawn, returns
  // structured {stdout, stderr, code, duration_ms} on success or
  // {error: "..."} on failure (which the Python proxy lifts to ShellError).
  //
  // No blocklist here despite Bash having one. Design rationale: the Bash
  // tool's blocks (cat/grep/find/sed/awk) exist to fight the Bash↔Repl
  // zigzag. Inside codemode, the model is already in Python — there's no
  // zigzag to prevent. If the model calls `shell.run("cat f | grep x")`
  // it made a deliberate compositional choice. Respect that. If it uses
  // shell.run for things namespace primitives do better, nudge via the
  // shell.py docstring, not via runtime blocks.

  /**
   * Route shell_request from Python to dispatchShellMethod. Shape mirrors
   * handleFsCallback exactly.
   */
  private async handleShellCallback(
    req: { id: number; method: string; args: Record<string, unknown> },
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.dispatchShellMethod(req.method, req.args);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.process?.write(JSON.stringify({
      shell_response: { id: req.id, result },
    }));
  }

  /**
   * Dispatch shell operations. Currently only `run` — but keeping the
   * switch structure so future ops (`spawn` for long-running, `pipe` for
   * streaming, etc.) slot in without architectural churn.
   */
  private async dispatchShellMethod(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'run': {
        const cmd = args.cmd as string;
        const timeoutSec = (args.timeout as number) ?? 30;
        const rawCwd = args.cwd as string | undefined;
        if (!cmd || typeof cmd !== 'string') {
          throw new Error('shell.run: cmd required');
        }

        // Resolve cwd — if the caller passed one, it must be inside the
        // workspace. Without this, `shell.run("rm -rf /", cwd="/")` would
        // be free to damage anything. Same boundary rule as fs.write.
        let effectiveCwd = this.cwd;
        if (rawCwd) {
          const absCwd = resolve(this.cwd, rawCwd);
          this.assertInsideWorkspace(absCwd, 'shell.run cwd');
          effectiveCwd = absCwd;
        }

        return await this.runShellCommand(cmd, effectiveCwd, timeoutSec * 1000);
      }

      default:
        throw new Error(`unknown shell method: ${method}`);
    }
  }

  /**
   * Spawn a shell child process, capture stdout/stderr, enforce timeout.
   *
   * Why spawn over exec:
   *   `exec()` throws on non-zero exit codes which forces awkward error
   *   handling to distinguish "command ran, exited 1" (data, not error)
   *   from "command could not be run" (actual error). spawn gives us
   *   both streams and exit code directly via events — cleaner.
   *
   * Why the system shell (`/bin/sh` / `cmd.exe`):
   *   The model writes shell commands (`npm test`, `git status`,
   *   `x | grep y`) that assume shell-level parsing — pipes, redirects,
   *   env expansion. Passing via `{shell: true}` or via /bin/sh -c is
   *   how you honor that. Without a shell, `npm test` alone would try
   *   to exec a binary named "npm test" (with the space).
   *
   * Output caps: capped at 2MB stdout + 2MB stderr combined to prevent
   * pathological commands (`yes`, `find /`) from exploding memory.
   * Beyond the cap we truncate with a sentinel; model sees the truncation.
   */
  private runShellCommand(
    cmd: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolveP) => {
      const start = Date.now();
      const isWin = process.platform === 'win32';
      const shellBin = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
      const shellArg = isWin ? '/c' : '-c';

      const child = spawn(shellBin, [shellArg, cmd], {
        cwd,
        shell: false, // we are explicitly the shell; don't double-wrap
        env: process.env,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      const MAX_OUTPUT = 2_000_000;
      let outputTruncated = false;

      const capture = (buf: string, chunk: Buffer) => {
        const remaining = MAX_OUTPUT - buf.length;
        if (remaining <= 0) {
          outputTruncated = true;
          return buf;
        }
        const s = chunk.toString('utf-8');
        if (s.length <= remaining) return buf + s;
        outputTruncated = true;
        return buf + s.slice(0, remaining) + '\n...[truncated at 2MB]...\n';
      };

      child.stdout?.on('data', (c) => { stdout = capture(stdout, c); });
      child.stderr?.on('data', (c) => { stderr = capture(stderr, c); });

      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        const duration_ms = Date.now() - start;
        if (killed) {
          // Timeout — surface as error so Python raises ShellError. Return
          // whatever partial output we captured; losing it would blind the
          // model to why the command timed out.
          resolveP({
            error: `shell.run: timed out after ${timeoutMs}ms. Partial output follows.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
          });
          return;
        }
        resolveP({
          ok: true,
          stdout,
          stderr,
          code: code ?? -1,
          duration_ms,
          truncated: outputTruncated,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolveP({
          error: `shell.run: spawn failed (${err.message}). cmd='${cmd.slice(0, 200)}'`,
        });
      });
    });
  }

  // ── Web callback handler ─────────────────────────────────────────────────
  // Delegates to the existing WebFetchTool / WebSearchTool classes. Zero
  // re-implementation of HTTP fetch, HTML cleaning, DDG fallback chain,
  // Tavily/Brave/Serper/SerpAPI providers — that logic has taken months
  // to stabilize and must not be forked. If a bug exists there, fix it
  // in the tool; web.fetch/web.search inherit the fix for free.

  /** Route web_request from Python through dispatchWebMethod. */
  private async handleWebCallback(
    req: { id: number; method: string; args: Record<string, unknown> },
  ): Promise<void> {
    let result: unknown;
    try {
      result = await this.dispatchWebMethod(req.method, req.args);
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.process?.write(JSON.stringify({
      web_response: { id: req.id, result },
    }));
  }

  /**
   * Dispatch fetch and search by constructing the relevant tool and calling
   * its execute(). Tools have no external state (WebFetchTool is stateless,
   * WebSearchTool only holds its cfg) so we construct per-call. Cheap.
   */
  private async dispatchWebMethod(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case 'fetch': {
        const url = args.url as string;
        const maxLength = (args.max_length as number) ?? 50_000;
        if (!url || typeof url !== 'string') {
          throw new Error('web.fetch: url required');
        }
        const tool = new WebFetchTool();
        // WebFetchTool.execute returns a ToolResult with {output, isError}.
        // Convert to the same shape the model's try/except expects: on
        // success return the raw text, on error raise (by surfacing
        // {error} back to Python).
        const r = await tool.execute({ url, maxLength });
        if (r.isError) {
          throw new Error(r.output);
        }
        return r.output;
      }

      case 'search': {
        const query = args.query as string;
        const maxResults = (args.max_results as number) ?? 10;
        if (!query || typeof query !== 'string') {
          throw new Error('web.search: query required');
        }
        const tool = new WebSearchTool(this.webSearchConfig);
        const r = await tool.execute({ query, maxResults });
        if (r.isError) {
          throw new Error(r.output);
        }
        // WebSearchTool returns formatted text blocks, one per result, in a
        // single string. Python expects a list[dict]. Parse the blocks back
        // to structured form for consistency with the docstring contract.
        // Format produced by every backend: "title\nurl\nsnippet\n" separated
        // by blank lines. First block may start with "Answer: ..." (Tavily /
        // Serper answer box) — we keep that as an extra field.
        return parseWebSearchOutput(r.output, maxResults);
      }

      default:
        throw new Error(`unknown web method: ${method}`);
    }
  }

  // ── Say / Ask handlers ───────────────────────────────────────────────────
  // These are the codemode-A6 primitives — the agent's voice inside the Repl.
  // Unlike fs/shell/web which dispatch to existing TS-side tools, say/ask
  // route directly to UI callbacks registered by app.tsx via setOnSay/setOnAsk.
  // The bridge is effectively a passthrough here; the interesting work lives
  // in app.tsx (appending assistant text, rendering the modal).

  /**
   * Handle a say notification from Python. Fire-and-forget — Python has
   * already continued by the time this lands. We surface to the registered
   * UI handler AND to the general onEvent stream so debug loggers can see
   * every say() emission. UI handler errors must not propagate (they'd
   * only reach the onLine catch, which eats them, but a noisy console
   * stack trace is still bad UX for anyone not looking at the TS host).
   */
  private dispatchSay(payload: { text?: string }): void {
    const text = typeof payload?.text === 'string' ? payload.text : String(payload?.text ?? '');
    // Specific UI channel — the thing that actually renders.
    try {
      this.onSay?.(text);
    } catch {
      // never let UI callback errors break the bridge
    }
    // General event channel — observable via onEvent for logging/tracing.
    this.emit({ type: 'repl_say', text });
  }

  // Dispatch done(value) commit from the Python body. No specific UI channel
  // is registered (there's no onDone equivalent to onSay) because done() is
  // a commitment signal meant for telemetry/loop consumption rather than
  // user-visible rendering. If a future UI wants to surface "answer
  // committed" toasts, add an onDone handler alongside onSay.
  private dispatchDone(payload: { value?: unknown }): void {
    const value = payload?.value;
    this.emit({ type: 'repl_done', value });
  }

  /**
   * Handle an ask_request from Python. The Python side is blocked on a
   * threading.Event waiting for ask_response — we fire the UI handler and
   * trust it to eventually call resolveAsk. If no handler is registered,
   * Python times out on its own (default 300s in body/speak.py).
   *
   * Unlike fs/research/vault handlers, this one does NOT write a response
   * here — the response is written later by resolveAsk(), after the user
   * has actually typed something into the modal. That asymmetry is why
   * ask lives with a UI callback and not inside dispatchAskMethod.
   */
  private handleAskCallback(req: { id: number; question: string }): void {
    const id = req.id;
    const question = typeof req.question === 'string' ? req.question : String(req.question);
    try {
      this.onAsk?.(id, question);
    } catch {
      // never let UI callback errors break the bridge
    }
    // Also surface through the general event channel — same observability
    // reasoning as say. Subscribers can log without intercepting the modal.
    this.emit({ type: 'repl_ask', id, question });
  }

  /**
   * Ensure a resolved absolute path is inside the workspace root.
   * Throws with a teaching error — the message IS the model's next-step hint.
   *
   * Boundary trick: we compare `absPath + sep` against `cwd + sep`. Without
   * the trailing separator, a cwd of `/work/proj` would incorrectly accept
   * `/work/project-next/evil.ts` because the second literally starts with
   * the first as a substring. The separator forces a path-boundary check.
   * The `absPath === cwd` escape hatch allows writing to the workspace
   * root itself (rare but legitimate — e.g. a new top-level file).
   */
  private assertInsideWorkspace(absPath: string, op: string): void {
    const rootWithSep = this.cwd.endsWith(sep) ? this.cwd : this.cwd + sep;
    const targetWithSep = absPath + sep;
    // Allow writes to ~/.aries/ â€” the agent's own config directory
    const ariesDir = (homedir() ?? '') + sep + '.aries' + sep;
    const isAriesConfig = targetWithSep.startsWith(ariesDir);
    if (absPath !== this.cwd && !targetWithSep.startsWith(rootWithSep) && !isAriesConfig) {
      throw new Error(
        `${op}: path outside workspace (${absPath}). Only paths inside ${this.cwd} are allowed. For paths outside the workspace, call ask(question) to get explicit user approval first — per-call permission prompts are not wired for fs.* yet (A1 minimum-viable).`
      );
    }
  }

  /** Create a research event emitter that forwards events to the UI. */
  private makeResearchEmitter(): (e: ResearchEvent) => void {
    return (e: ResearchEvent) => {
      try { this.opts.onEvent?.({ type: 'research_event' as any, event: e } as any); } catch { /* never break on UI errors */ }
    };
  }

  /** Jina Reader fetch function — constructed fresh per ingest call. */
  private makeFetchFn(): (url: string) => Promise<string> {
    return async (url: string) => {
      try {
        const r = await fetch(`https://r.jina.ai/${url}`, {
          headers: { Accept: 'text/markdown' },
          signal: AbortSignal.timeout(15_000),
        });
        return r.ok ? await r.text() : '';
      } catch {
        return '';
      }
    };
  }
}
