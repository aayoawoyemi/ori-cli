/**
 * Helper: spin up a REPL bridge from config, wired to a trajectory logger.
 *
 * Returns null if repl is disabled in config. Otherwise returns a started
 * bridge ready for exec() calls.
 */
import { ReplBridge } from './bridge.js';
import { TrajectoryLogger, defaultTrajectoryPath } from './trajectory.js';
import { join, resolve } from 'node:path';
import type { ReplConfig, WebSearchConfig } from '../config/types.js';
import type { CodeExecution, ReplResult, ReplEvent } from './types.js';
import { OriVault, findProjectVault } from '../memory/vault.js';
import type { ModelRouter } from '../router/index.js';

// Cross-platform shell label for the first-turn banner. Kept as a function
// (not a const) because tests / future platforms may stub process.platform,
// and we want the value computed at call-time rather than module-load time.
// Matches the shell-selection logic at src/repl/bridge.ts runShellCommand
// ("cmd.exe" on win32, "/bin/sh" elsewhere) so the banner matches reality.
function currentShell(): string {
  return process.platform === 'win32' ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh';
}

// Session "mode" — controls whether the CLI treats cwd as a project to
// index OR as the vault itself. A10 surfaced the collision: when the user
// launches `ori` from ~/brain, cwd == vaultPath, and the old code indexed
// 952 markdown notes as "code" and workspace-gated every project edit.
// The rule is crisp: same directory => vault-only. Anything else =>
// project + vault. We resolve both paths to normalize trailing separators,
// mixed casing on Windows, and tilde-expansion before comparing.
export function computeMode(cwd: string, vaultPath: string | undefined): 'project+vault' | 'vault-only' {
  if (!vaultPath) return 'project+vault';
  return resolve(cwd) === resolve(vaultPath) ? 'vault-only' : 'project+vault';
}

export interface ReplHandle {
  bridge: ReplBridge;
  logger: TrajectoryLogger;
  exec: (execution: CodeExecution, signal?: AbortSignal) => Promise<ReplResult>;
  shutdown: () => Promise<void>;
  isAlive: () => boolean;
}

export interface SetupOptions {
  config: ReplConfig;
  cwd: string;
  /** Custom trajectory path. Defaults to <cwd>/.aries/repl-traces/<ts>.jsonl */
  trajectoryPath?: string;
  /** If provided, auto-connects the vault at startup. */
  vaultPath?: string;
  /** If provided, auto-configures rlm_call with this API key. */
  rlmApiKey?: string;
  /** Base URL for rlm_call provider (e.g. https://openrouter.ai/api/v1). */
  rlmBaseUrl?: string;
  /** Model to use for rlm_call. Defaults to qwen/qwen3-14b via OpenRouter. */
  rlmModel?: string;
  /** Event callback (restart notifications, errors). */
  onEvent?: (e: ReplEvent) => void;
  /** Vault reference for proxy callbacks. */
  vault?: OriVault | null;
  /** Whether to auto-index the codebase. Set false when cwd is not a project dir. */
  shouldIndex?: boolean;
  /** Model router — wired to the bridge so research.extract/synthesize can call cheapCall. */
  router?: ModelRouter | null;
  /** Whether to auto-connect the research proxy at startup. Defaults true. */
  connectResearch?: boolean;
  /**
   * Web search provider config — used by web.search callbacks inside Repl.
   * When omitted, WebSearchTool falls back to env vars (TAVILY_API_KEY etc)
   * then DDG. Pass the AriesConfig.webSearch block through from app.tsx.
   */
  webSearchConfig?: WebSearchConfig;
  /**
   * Bridge-side vault response trim gate (v0.5 Phase 1, 2026-04-21).
   * Defaults to true if omitted — strips decoration fields from vault
   * MCP responses before they reach the Python proxy. Wire through from
   * AriesConfig.signature.trimVaultReturns.
   */
  trimVaultReturns?: boolean;
}

/**
 * If config.enabled is true, spawn the body subprocess and return a handle.
 * If disabled, returns null.
 */
export async function setupReplBridge(
  opts: SetupOptions,
): Promise<ReplHandle | null> {
  if (!opts.config.enabled) return null;

  const logger = new TrajectoryLogger(
    opts.trajectoryPath ?? defaultTrajectoryPath(opts.cwd),
  );

  // Mode drives three things:
  //   1. Whether we index the codebase (vault-only => skip; a vault that
  //      happens to have .git should not be indexed as source code).
  //   2. What the banner announces to the model.
  //   3. The semantics of "project vault" (only exists in project+vault
  //      mode; in vault-only mode we're already AT the vault, no second
  //      layer above it).
  const mode = computeMode(opts.cwd, opts.vaultPath);
  const shell = currentShell();

  // Project-vault discovery (Fix 1B). Walk up from opts.cwd looking for an
  // existing .ori/ that's NOT the global vault. Only done in project+vault
  // mode — in vault-only mode we're already inside the vault so there's no
  // separate project layer above it. Discovery is purely read-only here;
  // the auto-create path (first scope="project" add) runs in the bridge's
  // ensureProjectVault on demand, not at startup.
  const projectVaultPath = mode === 'project+vault'
    ? findProjectVault(opts.cwd, opts.vaultPath)
    : null;

  // Honor explicit opts.shouldIndex if passed; otherwise derive from mode.
  // vault-only ALWAYS skips indexing regardless of what the caller asked
  // for — this is the whole point of the mode. If a caller genuinely wants
  // to index a vault directory as code, they can skip the setup helper and
  // call bridge.index() manually; the helper enforces the rule.
  const indexingEnabled = mode === 'vault-only' ? false : (opts.shouldIndex !== false);

  const bridge = new ReplBridge({
    serverPath: opts.config.serverPath,
    pythonCmd: opts.config.pythonCmd,
    timeoutMs: opts.config.timeoutMs,
    maxRestarts: opts.config.maxRestarts,
    onEvent: opts.onEvent,
    onRestart: async () => {
      // Re-initialize everything after body process restarts.
      // Without this, codebase/vault/rlm_call are undefined after restart.
      //
      // Order matters: configure FIRST so the banner is correct on the
      // first post-restart exec. Codebase/vault/research reconnect after —
      // they update the namespace but don't affect the displayed metadata.
      try {
        await bridge.configure({
          project: opts.cwd,
          vaultGlobal: opts.vaultPath,
          // The project vault (OriVault instance) survives body-process
          // restart because it's held on the bridge, not the body. No
          // reconnect needed; just re-send its path to the new body so
          // the banner is correct post-restart.
          vaultProject: bridge.getProjectVault()?.vaultPath ?? null,
          mode,
          shell,
        });
      } catch (err) {
        opts.onEvent?.({
          type: 'bridge_error',
          error: `post-restart configure failed: ${(err as Error).message}`,
        });
      }
      if (indexingEnabled) {
        try {
          await bridge.index({ repoPath: opts.cwd });
        } catch (err) {
          opts.onEvent?.({
            type: 'bridge_error',
            error: `post-restart re-index failed: ${(err as Error).message}`,
          });
        }
      }
      if (opts.vaultPath) {
        try {
          await bridge.connectVault({ vaultPath: opts.vaultPath });
        } catch (err) {
          opts.onEvent?.({
            type: 'bridge_error',
            error: `post-restart vault reconnect failed: ${(err as Error).message}`,
          });
        }
      }
      if (opts.rlmApiKey) {
        try {
          await bridge.configureRlm({
            apiKey: opts.rlmApiKey,
            baseUrl: opts.rlmBaseUrl,
            model: opts.rlmModel,
            maxCalls: opts.config.maxRlmCalls,
          });
        } catch (err) {
          opts.onEvent?.({
            type: 'bridge_error',
            error: `post-restart rlm config failed: ${(err as Error).message}`,
          });
        }
      }
      if (opts.connectResearch !== false) {
        try {
          await bridge.connectResearch();
        } catch (err) {
          opts.onEvent?.({
            type: 'bridge_error',
            error: `post-restart research reconnect failed: ${(err as Error).message}`,
          });
        }
      }
    },
  });

  // Set cwd BEFORE bridge.start() — createProcess reads this.cwd when
  // spawning the Python body, so if we set it after, the body spawns with
  // the TS process's cwd instead of opts.cwd. The fs.write/fs.edit gate
  // and the Python body's relative-path resolution both have to see the
  // same workspace root for A10 task 1 (read package.json) to work when
  // the user launched `ori` from a different directory than their project.
  bridge.setCwd(opts.cwd);

  await bridge.start();

  // Ship environment metadata to the body BEFORE the first exec. The body
  // renders a turn-one banner from these values; if we land the configure
  // op after an exec has already run, the banner has nothing to show and
  // the model discovers the environment by failure instead of by
  // announcement. A10 surfaced this as a blocker: without project/vault/
  // mode/shell in the banner, every wrong-cwd session burns 2-3 turns
  // recovering from errors the banner could have prevented.
  //
  // Non-fatal: a configure failure still lets the body run, just with a
  // less-informative banner. Log and keep moving — the alternative is
  // aborting every session on a cosmetic-display failure.
  // Connect the project vault BEFORE sending configure — this way the
  // banner's "Vault (project):" line reflects whether a project vault is
  // actually connected, not merely whether one was discovered on disk.
  // Connect failure is non-fatal: the banner degrades to "(none — ...)"
  // and scope="project" ops throw teaching errors until the next restart.
  if (projectVaultPath) {
    try {
      const pv = new OriVault(projectVaultPath);
      await pv.connect();
      bridge.setProjectVault(pv);
    } catch (err) {
      opts.onEvent?.({
        type: 'bridge_error',
        error: `project vault auto-connect failed (${projectVaultPath}): ${(err as Error).message}`,
      });
    }
  }

  try {
    await bridge.configure({
      project: opts.cwd,
      vaultGlobal: opts.vaultPath,
      vaultProject: bridge.getProjectVault()?.vaultPath ?? null,
      mode,
      shell,
    });
  } catch (err) {
    opts.onEvent?.({
      type: 'bridge_error',
      error: `initial configure failed (banner degraded, sessions still work): ${(err as Error).message}`,
    });
  }

  // Pass web-search provider config through so web.search (inside Repl)
  // uses the user's configured backend (Tavily/Brave/Serper/SerpAPI). If
  // unset, WebSearchTool still works via env-var resolution + DDG fallback.
  if (opts.webSearchConfig) {
    bridge.setWebSearchConfig(opts.webSearchConfig);
  }

  // Bridge-side trim gate (v0.5 Phase 1). When omitted, bridge's default
  // (true) takes effect — Phase 1 ships trim on. Callers can force off
  // by passing trimVaultReturns: false explicitly.
  if (typeof opts.trimVaultReturns === 'boolean') {
    bridge.setTrimVaultReturns(opts.trimVaultReturns);
  }

  // Give bridge the vault reference for proxy callbacks
  if (opts.vault) {
    bridge.setVault(opts.vault);
  }

  // Give bridge the router so research.extract/synthesize can call cheapCall
  if (opts.router) {
    bridge.setRouter(opts.router);
  }

  // Set research output dir: vault/research if vault exists, else cwd/research
  const researchOutputDir = opts.vaultPath
    ? join(opts.vaultPath, 'research')
    : join(opts.cwd, 'research');
  bridge.setResearchOutputDir(researchOutputDir);

  // Optional: auto-connect vault at startup
  if (opts.vaultPath) {
    try {
      const r = await bridge.connectVault({ vaultPath: opts.vaultPath });
      if (!r.ok) {
        // non-fatal — bridge still works, just without vault in namespace
        opts.onEvent?.({
          type: 'bridge_error',
          error: `vault auto-connect failed: ${r.error ?? 'unknown'}`,
        });
      }
    } catch (err) {
      opts.onEvent?.({
        type: 'bridge_error',
        error: `vault auto-connect exception: ${(err as Error).message}`,
      });
    }
  }

  // Optional: auto-configure rlm_call
  if (opts.rlmApiKey) {
    try {
      const r = await bridge.configureRlm({
        apiKey: opts.rlmApiKey,
        baseUrl: opts.rlmBaseUrl,
        model: opts.rlmModel,
        maxCalls: opts.config.maxRlmCalls,
      });
      if (!r.ok) {
        opts.onEvent?.({
          type: 'bridge_error',
          error: `rlm_call config failed: ${r.error ?? 'unknown'}`,
        });
      }
    } catch (err) {
      opts.onEvent?.({
        type: 'bridge_error',
        error: `rlm_call config exception: ${(err as Error).message}`,
      });
    }
  }

  // Auto-connect research proxy (always on — research is always available)
  if (opts.connectResearch !== false) {
    try {
      const r = await bridge.connectResearch();
      if (!r.ok) {
        opts.onEvent?.({
          type: 'bridge_error',
          error: `research connect failed: ${r.error ?? 'unknown'}`,
        });
      }
    } catch (err) {
      opts.onEvent?.({
        type: 'bridge_error',
        error: `research connect exception: ${(err as Error).message}`,
      });
    }
  }

  return {
    bridge,
    logger,
    async exec(execution, signal) {
      const result = await bridge.exec(execution, signal);
      logger.log(execution, result);
      return result;
    },
    async shutdown() {
      // Disconnect the project vault's MCP subprocess before the bridge
      // itself goes down — ori-memory's flushSession (Q-value batch
      // rewards, warmth normalization) runs on 'beforeExit' via stdin
      // EOF, so we have to close stdin cleanly rather than SIGKILL. The
      // global vault is owned by app.tsx / index.ts and disconnects on
      // its own lifecycle; we only touch the project vault, which IS
      // owned here (setupReplBridge created it in the projectVaultPath
      // block).
      const pv = bridge.getProjectVault();
      if (pv) {
        try { pv.disconnect(); } catch { /* best effort */ }
      }
      await bridge.shutdown();
    },
    isAlive() {
      return bridge.isAlive();
    },
  };
}
