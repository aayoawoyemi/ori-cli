/**
 * Helper: spin up a REPL bridge from config, wired to a trajectory logger.
 *
 * Returns null if repl is disabled in config. Otherwise returns a started
 * bridge ready for exec() calls.
 */
import { ReplBridge } from './bridge.js';
import { TrajectoryLogger, defaultTrajectoryPath } from './trajectory.js';
import type { ReplConfig } from '../config/types.js';
import type { CodeExecution, ReplResult, ReplEvent } from './types.js';
import type { OriVault } from '../memory/vault.js';

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
  anthropicApiKey?: string;
  /** Model to use for rlm_call. Defaults to claude-sonnet-4-5. */
  rlmModel?: string;
  /** Event callback (restart notifications, errors). */
  onEvent?: (e: ReplEvent) => void;
  /** Vault reference for proxy callbacks. */
  vault?: OriVault | null;
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

  const bridge = new ReplBridge({
    serverPath: opts.config.serverPath,
    pythonCmd: opts.config.pythonCmd,
    timeoutMs: opts.config.timeoutMs,
    maxRestarts: opts.config.maxRestarts,
    onEvent: opts.onEvent,
    onRestart: async () => {
      // Re-initialize everything after body process restarts.
      // Without this, codebase/vault/rlm_call are undefined after restart.
      try {
        await bridge.index({ repoPath: opts.cwd });
      } catch (err) {
        opts.onEvent?.({
          type: 'bridge_error',
          error: `post-restart re-index failed: ${(err as Error).message}`,
        });
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
      if (opts.anthropicApiKey) {
        try {
          await bridge.configureRlm({
            apiKey: opts.anthropicApiKey,
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
    },
  });

  await bridge.start();

  // Give bridge the vault reference for proxy callbacks
  if (opts.vault) {
    bridge.setVault(opts.vault);
  }

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
  if (opts.anthropicApiKey) {
    try {
      const r = await bridge.configureRlm({
        apiKey: opts.anthropicApiKey,
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

  return {
    bridge,
    logger,
    async exec(execution, signal) {
      const result = await bridge.exec(execution, signal);
      logger.log(execution, result);
      return result;
    },
    async shutdown() {
      await bridge.shutdown();
    },
    isAlive() {
      return bridge.isAlive();
    },
  };
}
