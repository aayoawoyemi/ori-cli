#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { loadConfig } from './config/load.js';
import { ModelRouter, isReplCapableModel } from './router/index.js';
import type { EffortLevel } from './router/index.js';
import { createCoreRegistry, registerMemoryTools } from './tools/registry.js';
import { buildComposeRequestSystemPrompt, buildSystemPrompt } from './prompt.js';
import { OriVault, findVault } from './memory/vault.js';
import { readExperienceLog } from './memory/experienceLog.js';
import { ProjectBrain } from './memory/projectBrain.js';
import { SessionStorage } from './session/storage.js';
import { UsageTracker } from './telemetry/tracker.js';
import { detectExistingSetup } from './onboarding/detect.js';
import { runOnboarding } from './onboarding/index.js';
import { App } from './ui/app.js';
import type { VaultIdentity } from './memory/vault.js';
import type { Message, SystemPromptInput } from './router/types.js';
import type { AriesConfig } from './config/types.js';
import { assembleWarmContext } from './memory/warmContext.js';
import { setupReplBridge, type ReplHandle } from './repl/setup.js';
import { registerCodeTool } from './tools/registry.js';
import { ComposeController } from './compose/controller.js';
import { classifyRequestMode, newRequestId } from './compose/router.js';
import { checkForUpdate, getLocalVersion } from './update/check.js';
import { printUpdateNotification } from './update/notify.js';
import type { UpdateResult } from './update/check.js';
import {
  registerLifecycleHandlers,
  onCleanupAsync,
  onCleanupSync,
  reapOrphans,
} from './lifecycle.js';

// ── Parchment Terminal ──────────────────────────────────────────────────
// Set warm walnut background + cream foreground via OSC escape sequences.
// Restores original colors on exit (including Ctrl+C).
const SET_BG = "\x1b]11;#1a1816\x07";
const SET_FG = "\x1b]10;#e8e0d4\x07";
const RESET_BG = "\x1b]111\x07";
const RESET_FG = "\x1b]110\x07";

function enterParchment(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(SET_BG + SET_FG);
}

function exitParchment(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(RESET_FG + RESET_BG);
}

// Lifecycle handlers wire EVERY exit path (signals, crashes, normal exit) to
// a centralized cleanup registry. The 2026-04-29 diagnosis confirmed that
// pre-this, only the happy-path Ink exit (waitUntilExit() → vault.disconnect
// + replHandle.shutdown at line ~775) ran cleanup. Ctrl+C during startup,
// uncaught exceptions, and hard kills all orphaned ori-memory subprocesses,
// leaving 11 zombies on the user's machine that pinned WAL read marks and
// held ~3GB of embedding model weights hostage.
//
// `logCrash` is defined further down (line ~785). Forward-declared via let so
// registerLifecycleHandlers can capture it now and use it later. The crash
// log file path stays in sync with the existing CRASH_LOG constant below.
let logCrashRef: ((label: string, err: unknown) => void) | null = null;
registerLifecycleHandlers({
  logCrash: (label, err) => logCrashRef?.(label, err),
});

// Sync cleanup: terminal restore. Always safe, fast — runs first on every
// exit path including the synchronous-only 'exit' event.
onCleanupSync(exitParchment);

interface AmbientSignatures {
  codebaseSignatureMd?: string;
  vaultSignatureMd?: string;
}

// Project markers — if none exist in cwd, skip codebase indexing
const PROJECT_MARKERS = [
  '.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'Makefile', 'CMakeLists.txt', '.project',
  'deno.json', 'composer.json', 'Gemfile', 'mix.exs', 'setup.py',
];

function isProjectDirectory(dir: string): boolean {
  const home = homedir();
  const resolved = resolve(dir);
  // Never index the home directory — stray config files (package.json etc.)
  // can trick the marker check, and indexing ~/ is always catastrophic.
  if (resolved === resolve(home)) return false;
  return PROJECT_MARKERS.some(marker => existsSync(join(dir, marker)));
}

// Indexing eligibility — stricter than isProjectDirectory because it ALSO
// rejects the collision case where cwd IS the vault. A vault with .git
// (all Ori vaults have it) passes isProjectDirectory but is exactly the
// case A10 caught: indexing ~/brain treats 952 markdown notes as source
// code and makes codebase.search return noise for every Python lookup.
// The rule is: cwd looks like a project AND cwd is not the vault. If
// you're reaching for a third callsite that needs this same check, use
// this helper — do NOT re-inline the collision compare.
function shouldIndexCodebase(cwd: string, vaultPath: string | undefined): boolean {
  if (!isProjectDirectory(cwd)) return false;
  if (vaultPath && resolve(cwd) === resolve(vaultPath)) return false;
  return true;
}

// ── rlm provider resolution ──────────────────────────────────────────────
// rlm_call / rlm_batch (the Python sub-reasoner inside the Repl body) route
// through an OpenAI-compatible client. Two providers supported today:
//   1. OpenRouter (primary) — wide model catalog, cheapest cost tier.
//   2. Anthropic direct (fallback) — via Anthropic's OpenAI-compat endpoint
//      at api.anthropic.com/v1/. Used when OPENROUTER_API_KEY is absent but
//      ANTHROPIC_API_KEY is set (e.g. user on Claude Max with OAuth only).
//
// Model defaults picked per-provider so the fallback is cheap and safe:
//   - OpenRouter path → 'openai/gpt-oss-20b'. ~$0.03/M input, $0.14/M output.
//     Outperforms Qwen3 32B on focused summarization benchmarks. Chosen
//     2026-04-19 (see body/rlm.py:39 for the full rationale).
//   - Anthropic fallback → 'claude-haiku-4-5-20251001'. Explicitly NOT
//     config.models.primary (which is usually Opus/Sonnet) — using the
//     primary for N-way fan-out was ~$150/month risk for heavy users.
//     Haiku at the Anthropic tier is 10-30× cheaper and more than adequate
//     for rlm sub-calls (short, focused, max ~60 words per answer).
//
// user override: config.repl.rlmModel (in aries.config.yaml) takes absolute
// precedence over the provider-aware default.
//
// Distribution note: this function ships with the CLI and runs on every
// user's machine. It reads ONLY public env vars (OPENROUTER_API_KEY,
// ANTHROPIC_API_KEY) — no Aayo-specific secrets baked in. Other devs
// bring their own keys; defaults here just shape the cost profile.

interface ResolvedRlmConfig {
  rlmApiKey?: string;
  rlmBaseUrl?: string;
  rlmModel: string;
}

function resolveRlmConfig(configRlmModel: string | undefined): ResolvedRlmConfig {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // No key available — rlm is effectively off. Return a sentinel model so
  // the downstream "rlm disabled" check can surface cleanly.
  if (!openrouterKey && !anthropicKey) {
    return { rlmModel: 'unset' };
  }

  if (openrouterKey) {
    return {
      rlmApiKey: openrouterKey,
      rlmBaseUrl: 'https://openrouter.ai/api/v1',
      rlmModel: configRlmModel ?? 'openai/gpt-oss-20b',
    };
  }

  // Anthropic fallback. Base URL is explicit — without it, AsyncOpenAI
  // (the Python client we use in rlm.py) defaults to api.openai.com which
  // would route an Anthropic key to the wrong provider and fail opaquely.
  // That was a pre-existing bug before this fallback rewrite.
  return {
    rlmApiKey: anthropicKey,
    rlmBaseUrl: 'https://api.anthropic.com/v1/',
    rlmModel: configRlmModel ?? 'claude-haiku-4-5-20251001',
  };
}

async function compileAmbientSignatures(
  replHandle: ReplHandle,
  options: {
    cwd: string;
    vaultPath?: string;
    signature: AriesConfig['signature'];
    log?: (line: string, isError?: boolean) => void;
  },
): Promise<AmbientSignatures> {
  const out: AmbientSignatures = {};

  // Skip codebase indexing if cwd isn't a project directory OR cwd IS the
  // vault (vault-only mode). See shouldIndexCodebase comment for the A10
  // reason this gate exists.
  if (!shouldIndexCodebase(options.cwd, options.vaultPath)) {
    const reason = !isProjectDirectory(options.cwd)
      ? 'no project detected'
      : 'cwd is the vault (vault-only mode)';
    options.log?.(`codebase signature: skipped (${reason})`);
  } else try {
    // 2026-05-03: startup indexing moved out of signature compilation for
    // headless. Pre-fix, includeInHeadless=false meant the bridge existed
    // but CODEBASE stayed as the not-ready stub; the first benchmark task
    // burned 23 model turns / 432K total tokens retrying codebase.search.
    // Signature compilation should consume an already-ready index when
    // present, and only index as a fallback for older / interactive paths
    // that haven't done readiness-gated startup indexing yet.
    let stats = await replHandle.bridge.codebaseStats();
    if ('error' in stats && stats.error) {
      const idxResult = await replHandle.bridge.index({ repoPath: options.cwd });
      if (!idxResult.ok) {
        options.log?.(`codebase signature: index failed (${idxResult.error ?? 'unknown'})`, true);
        stats = { error: idxResult.error ?? 'index failed' };
      } else {
        stats = await replHandle.bridge.codebaseStats();
      }
    }
    if (!('error' in stats) || !stats.error) {
      const sig = await replHandle.bridge.codebaseSignature(
        options.signature.codebase.level,
        options.signature.codebase.maxTokens,
      );
      if (!('error' in sig) || !sig.error) {
        out.codebaseSignatureMd = sig.markdown;
        options.log?.(
          `codebase signature: ${sig.approx_tokens} tokens (${options.signature.codebase.level})`,
        );
      }
    }
  } catch (err) {
    options.log?.(`codebase signature: ${(err as Error).message}`, true);
  }

  if (options.vaultPath) {
    try {
      const vs = await replHandle.bridge.vaultSignature(
        options.signature.vault.level,
        options.signature.vault.maxTokens,
      );
      if (!('error' in vs) || !vs.error) {
        out.vaultSignatureMd = vs.markdown;
        options.log?.(
          `vault signature: ${vs.approx_tokens} tokens (${options.signature.vault.level})`,
        );
      }
    } catch (err) {
      options.log?.(`vault signature: ${(err as Error).message}`, true);
    }
  }

  return out;
}

const args = process.argv.slice(2);
const cwd = resolve(process.cwd());

let modelOverride: string | undefined;
let promptArg: string | undefined;
let readOnlyMode = false;
let maxTurns = 50;
let continueSession = false;
let resumeArg: string | undefined;
let sessionName: string | undefined;
let headlessFlag = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model' || args[i] === '-m') {
    modelOverride = args[++i];
  } else if (args[i] === '--continue' || args[i] === '-c') {
    continueSession = true;
  } else if (args[i] === '--resume' || args[i] === '-r') {
    // Next arg is the session id/title/number (if it doesn't start with -)
    const next = args[i + 1];
    if (next && !next.startsWith('-')) {
      resumeArg = args[++i];
    } else {
      resumeArg = '';  // empty string = show picker
    }
  } else if (args[i] === '--name' || args[i] === '-n') {
    sessionName = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
${chalk.bold('Ori CLI')} - Memory-native coding agent

${chalk.dim('Usage:')}
  ori                      Start interactive session
  ori "prompt here"        Single prompt, then interactive
  ori --headless "task"    Run one compose-wired headless task and print result
  ori --model opus         Use a specific model slot
  ori -c                   Continue most recent session
  ori -r                   Resume a session (interactive picker)
  ori -r "title"           Resume session by title or ID

${chalk.dim('Options:')}
  -m, --model <slot>       Model slot: primary, reasoning, cheap, bulk
  -c, --continue           Continue most recent session
  -r, --resume [query]     Resume session by ID, title, or number
  -n, --name <title>       Name this session
  --headless               Run one prompt without the terminal UI
  -h, --help               Show this help
  --version                Show version

${chalk.dim('In-session commands:')}
  /model <slot>            Switch model for next turn
  /cost                    Show token usage
  /resume                  Resume a previous session
  /rename <title>          Rename current session
  /clear                   Clear conversation
  /tools                   List available tools
  /vault                   Show vault status
  /brain                   Show project brain contents
  /headless <task>         Launch a separate compose-wired headless session
  /help                    Show commands
  /exit                    Exit
`);
    process.exit(0);
  } else if (args[i] === '--version') {
    console.log(getLocalVersion());
    process.exit(0);
  } else if (args[i] === '--read-only') {
    readOnlyMode = true;
  } else if (args[i] === '--headless') {
    headlessFlag = true;
  } else if (args[i] === '--max-turns') {
    maxTurns = parseInt(args[++i], 10);
  } else if (!args[i].startsWith('-')) {
    promptArg = args[i];
  }
}

const config = loadConfig(cwd);
process.env.TZ = config.timezone;
const isHeadless = headlessFlag || process.env.ARIES_HEADLESS === '1';
// Loop3 is the default runtime as of 2026-05-06. Legacy loop (the original
// `agentLoop` from src/loop.ts with 14+ top-level tools) is opt-in via
// ARIES_LEGACY_LOOP=1 for fallback during the post-flip shakedown. Loop2
// remains an explicit opt-in escape hatch for headless bench reruns that
// reference its specific event types. Precedence: legacy > loop2 > loop3.
const useLegacyLoop = process.env.ARIES_LEGACY_LOOP === '1';
const useLoop2Headless = isHeadless && process.env.ARIES_LOOP2 === '1' && !useLegacyLoop;
const useLoop3Headless = isHeadless && !useLegacyLoop && !useLoop2Headless;
if (!isHeadless && process.env.ARIES_LOOP2 === '1' && !useLegacyLoop) {
  console.error(chalk.yellow('ARIES_LOOP2=1 is currently headless-only; interactive mode is using Loop3 (the default).'));
}

// Fire update check early — non-blocking, resolves in background
const updateCheckPromise: Promise<UpdateResult | null> = isHeadless
  ? Promise.resolve(null)
  : checkForUpdate().catch(() => null);

const detection = detectExistingSetup(cwd, config.vault.path);
if (!isHeadless && detection.isFirstRun) {
  const result = await runOnboarding();
  config.agent.name = result.agentName;
  if (result.vaultPath) {
    config.vault.path = result.vaultPath;
  }
}

let vault: OriVault | null = null;
let vaultIdentity: VaultIdentity | null = null;
let vaultNoteCount: number | undefined;

const vaultPath = config.vault.path || findVault();

// Orphan reaper: kill ori-memory subprocesses left over from previous aries
// sessions that exited hard. Runs once per startup, BEFORE we spawn our own
// MCP subprocess so we don't accidentally kill it. Only kills processes
// matching the fingerprint AND whose parent PID is dead — never touches
// subprocesses owned by other live sessions (Claude Desktop, sibling aries,
// etc.). The 2026-04-29 diagnosis found 11 zombies on the user's machine,
// each holding ~270MB of embedding model weights. Without the reaper, every
// crash compounds the leak.
if (!isHeadless) {
  const reaped = reapOrphans(['ori-memory', 'serve --mcp']);
  if (reaped > 0) {
    console.log(chalk.dim(`  reaped ${reaped} orphaned ori-memory subprocess${reaped === 1 ? '' : 'es'}`));
  }
  // Compose sub-loop: sweep orphan request-scratch markdown files (>24h old).
  // Belt-and-suspenders for sessions that crashed without normal teardown.
  // The per-request close is the primary cleanup path; this catches the
  // residue. Sync cleanup since file IO is fast and we want it to fire even
  // on signal-based exits.
  try {
    const { sweepOrphanScratches } = await import('./compose/scratch.js');
    const sweptCount = sweepOrphanScratches(cwd, 24);
    if (sweptCount > 0) {
      console.log(chalk.dim(`  swept ${sweptCount} orphan request-scratch file${sweptCount === 1 ? '' : 's'}`));
    }
  } catch {
    // Sweeper failure should never block startup. Stale files just persist
    // until the next successful sweep.
  }
}

if (vaultPath) {
  vault = new OriVault(vaultPath);
  // Register cleanup BEFORE connect — if connect fails partway and leaves a
  // child subprocess running, the cleanup handler still fires on shutdown
  // and disconnects it. Registering after connect would leak on the failure
  // path.
  onCleanupAsync(async () => {
    try { vault?.disconnect(); } catch { /* swallow */ }
  });
  try {
    await vault.connect();
    vaultIdentity = await vault.loadIdentity();
    const status = await vault.status();
    vaultNoteCount = status?.noteCount;
    if (!isHeadless) {
      console.log(chalk.dim(`Vault: ${vaultPath} (${vaultNoteCount ?? '?'} notes)`));
    }

    try {
      const orientResult = await vault.orient() as { data?: { summary?: string } } | null;
      if (!isHeadless && orientResult?.data?.summary) {
        console.log(chalk.dim(`  ${orientResult.data.summary.split('\n')[0]}`));
      }
    } catch {
      // non-fatal
    }
  } catch {
    if (!isHeadless) {
      console.log(chalk.dim(`Vault: ${vaultPath} (connection failed - running without vault)`));
    }
    vault = null;
  }
}

let projectBrain: ProjectBrain | null = null;
if (config.projectBrain.enabled) {
  projectBrain = new ProjectBrain(cwd);
  projectBrain.init();
  projectBrain.load();
  if (!isHeadless && projectBrain.count > 0) {
    console.log(chalk.dim(`Project brain: ${projectBrain.count} memories`));
  }
}

const session = new SessionStorage(cwd);
session.createMeta(config.models.primary?.model ?? 'unset', sessionName);
session.log({
  type: 'meta',
  model: config.models.primary?.model ?? 'unset',
  vault: vaultPath ?? null,
  cwd,
  agentName: config.agent.name,
  timestamp: Date.now(),
});

// ── Resume / Continue: load messages from a previous session ──────────
import { resumeFromSession } from './session/resume.js';
let resumedMessages: Message[] | null = null;

if (continueSession) {
  const last = session.getLastSession();
  if (last) {
    const result = resumeFromSession(session.getSessionPath(last.id));
    if (result.messages.length > 0) {
      resumedMessages = result.messages;
      console.log(chalk.dim(`  continuing: ${last.userTitle ?? last.title ?? last.id} (${result.messages.length} messages)`));
    }
  } else {
    console.log(chalk.dim('  no previous session to continue'));
  }
} else if (resumeArg !== undefined) {
  if (resumeArg === '') {
    // Empty = show picker at startup (handled by App via initialResumePicker prop)
    // We'll pass this through to the UI
  } else {
    const match = session.findSession(resumeArg);
    if (match) {
      const result = resumeFromSession(session.getSessionPath(match.id));
      if (result.messages.length > 0) {
        resumedMessages = result.messages;
        console.log(chalk.dim(`  resuming: ${match.userTitle ?? match.title ?? match.id} (${result.messages.length} messages)`));
      }
    } else {
      console.log(chalk.yellow(`  no session matching "${resumeArg}"`));
    }
  }
}

const router = new ModelRouter(config.models, config.experimental, config.features, config.cache);
// Propagate the session ID to providers so OpenAI-compatible requests can
// emit `prompt_cache_key` for cache affinity. Anthropic native is a no-op
// (no client-supplied affinity field on the wire). Idempotent — also
// applied to any later-created provider via ModelRouter.buildProvider.
router.setSessionId(session.sessionId);
let replHandleRef: ReplHandle | null = null;

// Resolve 'auto': enable REPL only if the active model is capable
const replEnabled = config.repl.enabled === 'auto'
  ? isReplCapableModel(router.info.model)
  : config.repl.enabled;

const registry = createCoreRegistry({ replEnabled, webSearch: config.webSearch, getHandle: () => replHandleRef });
registerMemoryTools(registry, vault, projectBrain);

if (replEnabled) {
  registerCodeTool(registry, () => replHandleRef);
}

const warmContext = await assembleWarmContext(vault, vaultIdentity);
if (!isHeadless && warmContext) {
  console.log(chalk.dim('  warm context loaded'));
}

if (modelOverride) {
  try {
    router.setModel(modelOverride);
  } catch {
    console.error(chalk.red(`Unknown model: ${modelOverride}. Available: ${ModelRouter.availableModels.join(', ')}`));
    process.exit(1);
  }
}

function unescapeXmlText(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}

function extractLoop2ExecutionOutput(xml: string): string {
  const doneMatches = [...xml.matchAll(/<done>([\s\S]*?)<\/done>/g)];
  if (doneMatches.length > 0) {
    return unescapeXmlText(doneMatches[doneMatches.length - 1]![1] ?? '');
  }
  const sayMatches = [...xml.matchAll(/<say>([\s\S]*?)<\/say>/g)];
  if (sayMatches.length > 0) {
    return sayMatches.map((m) => unescapeXmlText(m[1] ?? '')).join('\n');
  }
  return '';
}

if (isHeadless) {
  if (!promptArg) {
    process.stderr.write('Headless requires a prompt argument\n');
    process.exit(1);
  }

  let subCodebaseSignatureMd: string | undefined;
  let subVaultSignatureMd: string | undefined;
  let subRepl: ReplHandle | null = null;
  // Use shouldIndexCodebase so the headless's mini-bridge respects the same
  // vault-only collision rule as the main bridge. Without this, a headless
  // launched while cwd == vault would re-trigger markdown-as-code indexing
  // on every fork.
  const isProject = shouldIndexCodebase(cwd, vaultPath ?? undefined);

  // ── Headless Repl bridge lifecycle (2026-04-27) ─────────────────────────
  // Pre-fix this block was double-broken:
  //   1. Gated on `config.signature.includeInHeadless` — so when signatures
  //      were off, the bridge was never created at all, but the Repl tool
  //      stayed registered and codemode's default filter (loop.ts:384-388)
  //      still exposed it to the model.
  //   2. When the bridge WAS created, it was shut down inside the finally
  //      block immediately after signature compile, BEFORE the agent loop
  //      ran. Plus the local `subRepl` was never assigned to the module-
  //      level `replHandleRef` that CodeTool.getHandle() closes over —
  //      so even during signature compile the tool registry couldn't see
  //      it. End result: every headless Repl call hit the "REPL not
  //      available" rejection at src/tools/code.ts:386, and the system
  //      prompt was hardcoded to claim replEnabled=false (line 466 below).
  //
  // The bench (bench/2026-04/runs/2026-04-27/02-repl-failure-audit-aries-cli)
  // surfaced this as the smoking gun: model authored a correct Python error-
  // categorizer script, harness rejected it on the no-handle path, model had
  // no usable fallback in codemode default, runner SIGKILL'd at 5-min timeout.
  //
  // Fix: bridge creation now gated only on `replEnabled` (the resolved-from-
  // config decision the rest of the harness already made), bridge is wired
  // into `replHandleRef` so the tool registry sees it, and shutdown is
  // deferred until AFTER the agent loop drains. Signature compile is now an
  // independent inner gate — its absence no longer kills bridge availability.
  // The system prompt's `replEnabled` reflects bridge reality, not a guess.
  if (replEnabled) {
    try {
      const rlm = resolveRlmConfig(config.repl.rlmModel);
        subRepl = await setupReplBridge({
          config: config.repl,
          cwd,
          stateDir: join(session.dir, session.sessionId, 'state'),
          vaultPath: vaultPath ?? undefined,
        rlmApiKey: rlm.rlmApiKey,
        rlmBaseUrl: rlm.rlmBaseUrl,
        rlmModel: rlm.rlmModel,
        vault,
        shouldIndex: isProject,
        trimVaultReturns: config.signature.trimVaultReturns,
      });
      if (subRepl) {
        // Wire into the module-level ref so CodeTool.getHandle() (closure
        // over replHandleRef at line 390/394) returns this bridge during
        // the agent loop. This is the line whose absence pre-fix turned
        // every Repl call into "REPL not available" even when the bridge
        // was momentarily alive for signature compile.
        replHandleRef = subRepl;
        // Headless readiness gate: if this is a source project, do not let
        // the first model turn start until CODEBASE is real. Before this,
        // indexing only happened as a side effect of ambient-signature
        // compilation. When `signature.includeInHeadless` was false, the
        // model saw `code` plus the codebase namespace but hit the
        // _CodebaseNotReady stub on its first search. On 2026-05-04 that
        // produced a successful-but-bad bench cell: 23 code calls and
        // 432,906 total tokens for a one-hop read-only question. This gate
        // makes index readiness a substrate invariant instead of a prompt
        // convention or model-visible retry lesson.
        if (isProject) {
          session.log({ type: 'codebase_index', stage: 'start', timestamp: Date.now() });
          const idx = await subRepl.bridge.index({ repoPath: cwd });
          if (!idx.ok) {
            const message = idx.error ?? 'unknown index failure';
            session.log({
              type: 'codebase_index',
              stage: 'error',
              message,
              timestamp: Date.now(),
            });
            process.stderr.write(`Headless startup error: codebase index failed: ${message}\n`);
            try { await subRepl.shutdown(); } catch { /* best effort */ }
            replHandleRef = null;
            process.exit(1);
          } else {
            session.log({
              type: 'codebase_index',
              stage: 'ready',
              file_count: idx.file_count,
              symbol_count: idx.symbol_count,
              edge_count: idx.edge_count,
              elapsed_ms: idx.elapsed_ms,
              timestamp: Date.now(),
            });
          }
        } else {
          session.log({
            type: 'codebase_index',
            stage: 'skipped',
            reason: !isProjectDirectory(cwd) ? 'no project detected' : 'cwd is vault-only',
            timestamp: Date.now(),
          });
        }
        if (config.signature.includeInHeadless) {
          try {
            const sigs = await compileAmbientSignatures(subRepl, {
              cwd,
              vaultPath: vaultPath ?? undefined,
              signature: config.signature,
            });
            subCodebaseSignatureMd = sigs.codebaseSignatureMd;
            subVaultSignatureMd = sigs.vaultSignatureMd;
          } catch {
            // Signature compile is best-effort. Failure here just means the
            // headless enters the loop without ambient signatures — the
            // bridge stays up and the Repl tool keeps working.
          }
        }
      }
    } catch {
      // Fresh-context fallback is intentional. If bridge setup throws, the
      // headless runs without Repl: replEnabled in the system prompt becomes
      // false (computed below from `!!subRepl`) and the model will skip Repl
      // composition. Better than crashing on a transient body-spawn glitch.
      if (subRepl) {
        try { await subRepl.shutdown(); } catch { /* best effort */ }
        subRepl = null;
      }
      replHandleRef = null;
    }
  }

  const headlessSystemPrompt = buildSystemPrompt({
    cwd,
    config,
    vaultPath: vaultPath ?? undefined,
    vaultNoteCount,
    projectBrainCount: projectBrain?.count,
    vaultIdentity,
    warmContext,
    codebaseSignature: subCodebaseSignatureMd,
    vaultSignature: subVaultSignatureMd,
    replEnabled: !!subRepl,
    loop2: useLoop2Headless,
    loop3: useLoop3Headless,
    experienceLog: readExperienceLog(cwd),
  });

  const { agentLoop } = await import('./loop.js');
  const { agentLoop2 } = await import('./loop2.js');
  const { agentLoop3 } = await import('./loop3/agent.js');
  const { AnthropicToolUseAdapter } = await import('./loop3/adapters/anthropic.js');
  const headlessClassification = classifyRequestMode(promptArg);
  const headlessRequestId = newRequestId();
  const headlessIsComposeRequest =
    useLoop3Headless && (headlessClassification.mode === 'compose' || headlessClassification.mode === 'goal');
  const headlessModelInput = useLoop3Headless ? headlessClassification.cleanedText : promptArg;
  const headlessComposeController = useLoop3Headless
    ? new ComposeController({
        mode: headlessClassification.mode,
        requestId: headlessRequestId,
        onEvent: (e) => session.log({ ...e, timestamp: Date.now() } as any),
      })
    : null;
  const messages: Message[] = [{ role: 'user', content: headlessModelInput }];
  session.log({ type: 'user', content: promptArg, timestamp: Date.now() });
  if (useLoop3Headless) {
    session.log({
      type: 'request_mode_selected' as any,
      request_id: headlessRequestId,
      mode: headlessClassification.mode,
      reason: headlessClassification.reason,
      matched_trigger: headlessClassification.matchedTrigger,
      input_chars: promptArg.length,
      timestamp: Date.now(),
    } as any);
  }

  // Headless is the old subagent/bench execution path. The interactive UI
  // wires UsageTracker in app.tsx, but headless used to only write the
  // session JSONL. That left .aries/usage blind to bench/subtask turns and
  // made Level-1 composition work unmeasurable from the same telemetry surface
  // as normal sessions. Keep this local to headless so agentLoop stays a
  // pure event source.
  const usageTracker = new UsageTracker(session.sessionId, router.current.model);
  const unsubscribeCheapCallUsage = router.onCheapCallUsage(({
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  }) => {
    usageTracker.markTurnStart();
    usageTracker.recordTurn(model, provider, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
  });

  let finalText = '';
  let loop2CurrentText = '';
  let loop2NaturalFinalText = '';
  let loop3CurrentText = '';
  let loop3NaturalFinalText = '';
  let lastExecutionResult = '';
  let lastDoneOutput = '';
  // Capture the last successful code output as a fallback channel. A headless
  // that does all its work via code + done(value) emits zero assistant-text
  // events — finalText stays empty and the parent would see "(no output)."
  // The code tool_result's output_full contains say() narration (Batch 1.6
  // dual-write echoes say() into the exec-captured stdout) plus any print()
  // output, so surfacing the last non-error code output gives the parent
  // the headless's actual work. See Batch 1.8 — this is the structural
  // companion to fixing vault.top's snippet lie: both are "the harness
  // isn't surfacing what it claims to surface" bugs.
  let lastCodeOutputFull = '';

  if (useLoop3Headless) {
    if (subRepl?.bridge) {
      try {
        await subRepl.bridge.configure({
          sessionId: session.sessionId,
          requestId: headlessRequestId,
          composeMode: headlessClassification.mode,
        });
        if (headlessIsComposeRequest) {
          const intent = headlessClassification.cleanedText.split(/\r?\n/, 1)[0]?.slice(0, 120) ?? '';
          await subRepl.bridge.composeStart({
            intent,
            userRequest: headlessClassification.cleanedText,
            mode: headlessClassification.mode === 'goal' ? 'goal' : 'compose',
          });
          session.log({
            type: 'scratch_created' as any,
            request_id: headlessRequestId,
            mode: headlessClassification.mode,
            intent_chars: intent.length,
            timestamp: Date.now(),
          } as any);
        }
      } catch (err) {
        session.log({
          type: 'scratch_setup_error' as any,
          request_id: headlessRequestId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        } as any);
      }
    }
    const buildHeadlessLoopSystemPrompt = async (): Promise<SystemPromptInput> => {
      if (!headlessIsComposeRequest) return headlessSystemPrompt;
      let scratchContent = '';
      let scratchError: string | undefined;
      let verificationFilled = false;
      if (subRepl?.bridge) {
        try {
          const scratch = await subRepl.bridge.composeRead();
          scratchContent = scratch.content ?? '';
          scratchError = scratch.error;
          verificationFilled = Array.isArray(scratch.status?.sections_filled)
            && scratch.status.sections_filled.includes('verification');
        } catch (err) {
          scratchError = err instanceof Error ? err.message : String(err);
        }
      } else {
        scratchError = 'bridge unavailable';
      }
      return buildComposeRequestSystemPrompt(headlessSystemPrompt, {
        mode: headlessClassification.mode === 'goal' ? 'goal' : 'compose',
        requestId: headlessRequestId,
        scratchContent,
        scratchError,
        verificationFilled,
      });
    };
    const adapter = new AnthropicToolUseAdapter(router);
    let headlessTerminatedVia: 'natural' | 'error' | 'abort' | 'max_turns' = 'natural';
    try {
      for await (const event of agentLoop3({
        messages,
        systemPrompt: buildHeadlessLoopSystemPrompt,
        adapter,
        replHandle: subRepl,
        session,
        estimateTokens: (m) => router.current.estimateTokens(m),
        maxTurns,
        composeController: headlessComposeController,
      })) {
        if (event.type === 'model_start') {
          loop3CurrentText = '';
          usageTracker.markTurnStart();
        }
        if (event.type === 'usage') {
          usageTracker.recordTurn(
            router.current.model,
            router.current.name,
            event.inputTokens,
            event.outputTokens,
            event.cacheReadTokens ?? 0,
            event.cacheWriteTokens ?? 0,
          );
        }
        if (event.type === 'turn_complete') {
          if (event.cellCount === 0 && loop3CurrentText.trim()) {
            loop3NaturalFinalText = loop3CurrentText;
          }
          usageTracker.patchLastTurn(event.cellCount > 0 ? 1 : 0, event.cellCount > 0 ? ['Repl'] : [], event.cellCount);
        }
        if (event.type === 'text') {
          finalText += event.content;
          loop3CurrentText += event.content;
        }
        if (event.type === 'action_executed') {
          const parts = [
            ...event.result.sayTexts,
            event.result.stdout,
            event.result.stderr,
            event.result.exception,
            event.result.rejectedReason,
            event.result.runtime?.footer,
          ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
          if (parts.length > 0) lastCodeOutputFull = parts.join('\n');
        }
        if (event.type === 'done_committed') {
          if (typeof event.value === 'string') {
            lastDoneOutput = event.value;
          } else {
            try {
              lastDoneOutput = JSON.stringify(event.value, null, 2);
            } catch {
              lastDoneOutput = String(event.value);
            }
          }
        }
        if (event.type === 'error') {
          headlessTerminatedVia = 'error';
          const msg = event.error instanceof Error ? event.error.message : String(event.error);
          process.stderr.write(`Headless error: ${msg}\n`);
        }
      }
    } finally {
      if (headlessIsComposeRequest && subRepl?.bridge) {
        try {
          await subRepl.bridge.composeClose();
          session.log({
            type: 'scratch_closed' as any,
            request_id: headlessRequestId,
            mode: headlessClassification.mode,
            terminated_via: headlessTerminatedVia,
            ...headlessComposeController?.telemetry(),
            timestamp: Date.now(),
          } as any);
        } catch (err) {
          session.log({
            type: 'scratch_close_error' as any,
            request_id: headlessRequestId,
            error: err instanceof Error ? err.message : String(err),
            timestamp: Date.now(),
          } as any);
        }
      }
      session.log({
        type: 'request_completed' as any,
        request_id: headlessRequestId,
        mode: headlessClassification.mode,
        terminated_via: headlessTerminatedVia,
        ...headlessComposeController?.telemetry(),
        timestamp: Date.now(),
      } as any);
    }
  } else if (useLoop2Headless) {
    for await (const event of agentLoop2({
      messages,
      systemPrompt: headlessSystemPrompt,
      router,
      replHandle: subRepl,
      session,
      maxTurns,
    })) {
      if (event.type === 'model_start') {
        loop2CurrentText = '';
        usageTracker.markTurnStart();
      }
      if (event.type === 'usage') {
        usageTracker.recordTurn(
          router.current.model,
          router.current.name,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens ?? 0,
          event.cacheWriteTokens ?? 0,
        );
      }
      if (event.type === 'turn_complete') {
        if (event.toolCallCount === 0 && event.replCellCount === 0 && loop2CurrentText.trim()) {
          loop2NaturalFinalText = loop2CurrentText;
        }
        usageTracker.patchLastTurn(event.toolCallCount, event.toolNames, event.replCellCount);
      }
      if (event.type === 'text') {
        finalText += event.content;
        loop2CurrentText += event.content;
      }
      if (event.type === 'execution_result' && event.content.trim()) {
        lastExecutionResult = event.content;
      }
      if (event.type === 'done_committed') {
        if (typeof event.value === 'string') {
          lastDoneOutput = event.value;
        } else {
          try {
            lastDoneOutput = JSON.stringify(event.value, null, 2);
          } catch {
            lastDoneOutput = String(event.value);
          }
        }
      }
      if (event.type === 'error') {
        const msg = event.error instanceof Error ? event.error.message : String(event.error);
        process.stderr.write(`Headless error: ${msg}\n`);
      }
    }
  } else {
    for await (const event of agentLoop({
      messages,
      systemPrompt: headlessSystemPrompt,
      router,
      registry,
      toolContext: { cwd },
      vault,
      projectBrain,
      session,
      hooks: config.hooks,
      permissionMode: readOnlyMode ? ('plan' as const) : ('accept' as const),
      maxTurns,
    })) {
      if (event.type === 'model_start') {
        usageTracker.markTurnStart();
      }
      if (event.type === 'usage') {
        usageTracker.recordTurn(
          router.current.model,
          router.current.name,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens ?? 0,
          event.cacheWriteTokens ?? 0,
        );
      }
      if (event.type === 'turn_complete') {
        usageTracker.patchLastTurn(event.toolCallCount, event.toolNames, event.replCellCount);
      }
      if (event.type === 'text') finalText += event.content;
      if (event.type === 'tool_result' && event.name === 'code' && !event.isError) {
        const full = event.output_full ?? event.output;
        if (full && full.trim()) lastCodeOutputFull = full;
      }
      if (event.type === 'error') {
        const msg = event.error instanceof Error ? event.error.message : String(event.error);
        process.stderr.write(`Headless error: ${msg}\n`);
      }
    }
  }

  unsubscribeCheapCallUsage();
  const userMsgCount = messages.filter((m) => m.role === 'user').length;
  session.touch(userMsgCount, usageTracker.totals.cost);
  usageTracker.persistSessionSummary();

  if (!useLoop2Headless && !lastDoneOutput) {
    for (const entry of SessionStorage.readSession(session.path)) {
      if (entry.type !== 'done_committed') continue;
      const value = entry.value;
      if (typeof value === 'string') {
        lastDoneOutput = value;
      } else {
        try {
          lastDoneOutput = JSON.stringify(value, null, 2);
        } catch {
          lastDoneOutput = String(value);
        }
      }
    }
  }

  // Prefer assistant-text as the summary channel when present; fall back to
  // done(value), then the last code output so codemode-native headless runs
  // surface their actual work. The done fallback closes the 2026-05-02 silent
  // no-output gap where a task could commit via done() yet emit empty stdout.
  const headlessOutput = useLoop3Headless
    ? (lastDoneOutput || loop3NaturalFinalText || finalText || lastCodeOutputFull || '')
    : useLoop2Headless
      ? (lastDoneOutput || loop2NaturalFinalText || extractLoop2ExecutionOutput(lastExecutionResult) || '')
      : (finalText.trim() ? finalText : (lastDoneOutput || lastCodeOutputFull));
  process.stdout.write(headlessOutput);

  // Bridge shutdown happens AFTER the agent loop has fully drained — earlier
  // shutdown is what made pre-fix headless runs Repl-blind (see lifecycle
  // comment above). Best-effort: if the body subprocess is already gone or
  // hanging, swallow the error and let the explicit process.exit reap it.
  if (subRepl) {
    try { await subRepl.shutdown(); } catch { /* best effort */ }
    replHandleRef = null;
  }
  vault?.disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  const modelInfo = router.info;
  const authMode = config.models.primary?.auth === 'oauth'
    ? (config.experimental.localClaudeSubscription ? 'OAuth (local subscription)' : 'OAuth (disabled)')
    : 'API key';

  const agentLabel = vaultIdentity?.identity ? config.agent.name : 'Ori';

  // Set terminal title
  const { setTitleIdle } = await import('./ui/terminal.js');
  setTitleIdle(agentLabel, cwd);

  // ── Parchment mode ──────────────────────────────────────────────────
  enterParchment();

  // ── Startup banner ──────────────────────────────────────────────────
  // Elephant left, "ORI CLI" block letters right, breathing ○ by the elephant.
  const gold = chalk.hex('#c4a46c');      // antique gold — theme accent
  const brightGold = chalk.hex('#d4aa55'); // warm gold — ring highlight

  // Elephant sprite (14 lines, braille art)
  const elephant = [
    '⠀⡠⠐⠒⠀⠀⠒⡐⠤⠤⠒⠀⠀⠠⠤⡀⠠⡀⠀⠀⠀',
    '⢠⠊⠀⠀⠐⣶⣄⡉⢉⠀⠀⢀⠀⠀⠀⢜⣧⡌⢂⠀⠀',
    '⠔⠁⠀⠀⠀⠀⢿⣟⠉⠀⠀⠀⠀⠀⠀⠀⠙⠅⠀⠆⠀',
    '⢯⠆⠀⠀⠀⠀⠘⡟⠀⠀⣴⣲⡄⠀⠀⠀⢀⡆⠀⢲⠀',
    '⠘⣄⠀⠠⠀⠀⠀⢻⡾⠄⣈⣻⠀⠀⢀⠀⠸⡇⢠⣤⠀',
    '⠀⠈⠲⢄⣠⠀⠀⠘⣷⢀⡀⢽⠀⠀⠀⠀⠂⢷⣸⠃⠀',
    '⠀⠀⠈⣱⣄⠀⠀⠰⢻⣾⣯⣿⣀⡀⡀⠀⠀⣜⡃⠀⠀',
    '⠀⠀⠀⠹⣷⡝⢶⣤⣀⣹⣿⣿⣿⣿⣿⡄⠀⣿⡁⡀⠀',
    '⠀⠀⠀⠀⢹⡇⠀⠛⠻⠻⣟⣿⣿⣧⣜⣧⢸⠃⠙⠠⠀',
    '⠀⠀⠀⠀⠀⢷⠀⠀⠀⠀⢻⣿⣿⣿⣿⣿⢸⠀⠀⠀⠀',
    '⠀⠀⠀⠀⠀⠀⠒⠀⠀⠀⠀⢸⡿⣿⡟⢻⢸⠀⠀⠀⠀',
    '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠃⠉⠀⠘⢸⠀⠀⠀⠀',
    '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡠⣲⣰⡞⠀⠀',
    '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠶⠛⠀⠀⠀',
  ];

  // 7-line block letters "ORI CLI" — vertically centered against the elephant
  const blockText = [
    ' ██████  ██████  ██     ██████ ██      ██',
    '██    ██ ██   ██ ██    ██      ██      ██',
    '██    ██ ██████  ██    ██      ██      ██',
    '██    ██ ██   ██ ██    ██      ██      ██',
    ' ██████  ██   ██ ██     ██████ ██████  ██',
  ];

  const cliVersion = `v${getLocalVersion()}`;
  // Splash labels — explicit `project:` and `vault:` prefixes. The old
  // version rendered the vault as `~/brain` (path-last-segment glued to
  // `~/`), which visually read as "current directory" — so a user who
  // launched `ori` from aries-cli saw the splash say `~/brain` and
  // concluded they were accidentally in brain. They weren't — cwd was
  // aries-cli all along, the label was just lying about what it represents.
  // Fix: show both project AND vault, always labeled, using basenames so
  // the line stays short. For truly ambiguous cases (vault or project
  // whose basename collides with another path), the explicit prefix makes
  // it unambiguous.
  const projectBasename = cwd.split(/[/\\]/).pop() ?? cwd;
  const projectLabel = `project: ${projectBasename}`;
  const vaultLabel = vault?.connected
    ? `vault: ${vault.vaultPath?.split(/[/\\]/).pop() ?? 'brain'}`
    : '';
  const infoParts = [
    cliVersion,
    agentLabel !== 'Ori' ? agentLabel : null,
    projectLabel,
    vaultLabel || null,
  ].filter(Boolean) as string[];
  const infoLine = chalk.dim(infoParts.join('  ·  '));

  // Print: elephant on left, block text on right (centered), ring after elephant
  console.log('');
  const textStart = Math.floor((elephant.length - blockText.length) / 2);
  for (let i = 0; i < elephant.length; i++) {
    const art = gold(elephant[i]!);
    const textIdx = i - textStart;
    const text = textIdx >= 0 && textIdx < blockText.length
      ? '  ' + gold(blockText[textIdx]!)
      : '';
    console.log(`  ${art}${text}`);
  }
  // Ring + info line below the elephant
  if (!vault?.connected) {
    // No vault — nudge them toward setup
    console.log(`  ${brightGold('○')}  ${chalk.dim(cliVersion)}  ${chalk.hex('#c4a46c')('type /setup to configure your vault')}`);
  } else {
    console.log(`  ${brightGold('○')}  ${infoLine}`);
  }
  console.log('');

  // ── Update notification (non-blocking, already started) ─────────────
  const updateResult = await updateCheckPromise;
  printUpdateNotification(updateResult);

  // ── Build initial system prompt (no REPL yet — render immediately) ──
  const systemPrompt = buildSystemPrompt({
    cwd,
    config,
    vaultPath: vaultPath ?? undefined,
    vaultNoteCount,
    projectBrainCount: projectBrain?.count,
    vaultIdentity,
    warmContext,
    codebaseSignature: undefined,
    vaultSignature: undefined,
    loop3: process.env.ARIES_LOOP3 === '1',
    replEnabled, // declare intent — REPL tool is registered even before bridge is ready
    experienceLog: readExperienceLog(cwd),
  });

  // ── Render the Ink app IMMEDIATELY — user can type right away ──────
  const { waitUntilExit } = render(
    React.createElement(App, {
      agentName: agentLabel,
      cwd,
      router,
      registry,
      vault,
      projectBrain,
      session,
      systemPrompt,
      hooks: config.hooks,
      vaultNoteCount,
      initialPrompt: promptArg,
      initialPermissionMode: config.permissions.mode === 'auto' ? 'yolo' as const
        : config.permissions.mode === 'manual' ? 'default' as const
          : 'default' as const,
      replHandle: null, // will be set async
      resumedMessages,
      initialResumePicker: resumeArg === '',
      experimental: config.experimental,
      getReplHandle: () => replHandleRef,
    }),
    { exitOnCtrlC: false },
  );

  // Re-emit parchment colors after Ink initializes — Ink's render() may
  // reset terminal state on some platforms. OSC 10/11 are idempotent.
  enterParchment();

  // ── REPL bridge setup
  if (replEnabled) {
    (async () => {
      try {
        const rlm = resolveRlmConfig(config.repl.rlmModel);
        // Log the resolved path once at startup so users see which provider
        // is feeding rlm and can correct misconfiguration before spending
        // a billing cycle on the wrong model. Only emit when rlm is live.
        if (rlm.rlmApiKey) {
          const provider = rlm.rlmBaseUrl?.includes('openrouter') ? 'OpenRouter' : 'Anthropic';
          console.log(chalk.dim(`  rlm: ${provider} · ${rlm.rlmModel}`));
        }
        const handle = await setupReplBridge({
          config: config.repl,
          cwd,
          stateDir: join(session.dir, session.sessionId, 'state'),
          vaultPath: vaultPath ?? undefined,
          rlmApiKey: rlm.rlmApiKey,
          rlmBaseUrl: rlm.rlmBaseUrl,
          rlmModel: rlm.rlmModel,
          vault,
          router,
          shouldIndex: shouldIndexCodebase(cwd, vaultPath ?? undefined),
          trimVaultReturns: config.signature.trimVaultReturns,
          onEvent: (e) => {
            if (e.type === 'bridge_restart') {
              console.error(chalk.yellow(`  [repl] bridge_restart: ${e.reason} (attempt ${e.attempt})`));
            } else if (e.type === 'bridge_error') {
              console.error(chalk.yellow(`  [repl] bridge_error: ${'error' in e ? e.error : '(no message)'}`));
            }
          },
        });
        replHandleRef = handle;

        if (handle) {
          // Register replHandle cleanup as soon as it exists. Like vault, this
          // owns a child subprocess (the Python body, plus its descendants for
          // shell.run et al). Without registration, signal-based exits would
          // orphan the body. handle.shutdown() is idempotent and safe to call
          // even if the happy-path explicit shutdown at line ~830 also fires
          // — runCleanup gates on cleanupRunning so double-fire is a no-op.
          // Inside the truthy branch so TS narrows handle from `ReplHandle |
          // null` to `ReplHandle`.
          const liveHandle = handle;
          onCleanupAsync(async () => {
            try { await liveHandle.shutdown(); } catch { /* swallow */ }
          });


          // User-facing sandbox label. The internal config values
          // (`same_process` / `docker` / `firecracker`) are correct
          // identifiers but read like leaked dev output to a user trying
          // to understand their startup banner — `same_process` in
          // particular is verbose and only meaningful if you know the
          // codebase's sandbox-strategy enum. Translate to short, neutral
          // labels here. Keep the config enum unchanged.
          const sandboxLabel = config.repl.sandbox === 'same_process'
            ? 'inproc'
            : config.repl.sandbox;
          const parts: string[] = [sandboxLabel];
          if (vaultPath) parts.push('vault');
          if (process.env.OPENROUTER_API_KEY ?? process.env.ANTHROPIC_API_KEY) parts.push('rlm');
          console.log(chalk.dim(`  repl: body ready (${parts.join(' + ')})`));

          // Compile signatures in background — they'll be available for future turns
          compileAmbientSignatures(handle, {
            cwd,
            vaultPath: vaultPath ?? undefined,
            signature: config.signature,
            log: (line, isError) => {
              const msg = chalk.dim(`  ${line}`);
              if (isError) console.error(chalk.yellow(msg));
              else console.log(msg);
            },
          }).catch(() => {});
        }
      } catch (err) {
        console.error(chalk.yellow(`  repl: disabled (${(err as Error).message})`));
        replHandleRef = null;
      }
    })();
  }

  await waitUntilExit();
  // Happy-path explicit cleanup. The lifecycle registry would also fire on
  // 'exit', but that path is sync-only — running the async tail here means
  // vault.disconnect's stdin EOF + bridge.shutdown's graceful op get their
  // full window. Idempotent: runCleanup gates on cleanupRunning so a second
  // invocation from the 'exit' handler is a no-op.
  vault?.disconnect();
  if (replHandleRef) await replHandleRef.shutdown();
  process.exit(0);
}

// Global crash handlers — write to file since terminal may be frozen
import { writeFileSync } from 'node:fs';
const CRASH_LOG = join(homedir(), '.aries', 'crash.log');

function logCrash(label: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
  const entry = `[${new Date().toISOString()}] ${label}: ${msg}\n`;
  try { writeFileSync(CRASH_LOG, entry, { flag: 'a' }); } catch { /* ignore */ }
}

// Wire logCrash into the lifecycle module's forward-declared ref. The
// lifecycle handlers were registered above (line ~57) before logCrash was
// defined; this binding completes the connection so uncaughtException +
// unhandledRejection events inside lifecycle.ts get logged with the same
// CRASH_LOG path the rest of the system uses.
logCrashRef = logCrash;

main().catch((err) => {
  logCrash('main.catch', err);
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
