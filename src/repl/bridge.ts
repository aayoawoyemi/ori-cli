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
import type { OriVault } from '../memory/vault.js';
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

export class ReplBridge {
  private process: ReplProcess | null = null;
  private pending: PendingResolver[] = [];
  private restarting = false;
  private restartCount = 0;
  private vault: OriVault | null = null;
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
    if (absPath !== this.cwd && !targetWithSep.startsWith(rootWithSep)) {
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
