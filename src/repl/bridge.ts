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

export class ReplBridge {
  private process: ReplProcess | null = null;
  private pending: PendingResolver[] = [];
  private restarting = false;
  private restartCount = 0;
  private vault: OriVault | null = null;
  private router: ModelRouter | null = null;
  private researchOutputDir: string | null = null;
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
