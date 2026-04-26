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
import { buildSystemPrompt } from './prompt.js';
import { OriVault, findVault } from './memory/vault.js';
import { readExperienceLog } from './memory/experienceLog.js';
import { ProjectBrain } from './memory/projectBrain.js';
import { SessionStorage } from './session/storage.js';
import { detectExistingSetup } from './onboarding/detect.js';
import { runOnboarding } from './onboarding/index.js';
import { App } from './ui/app.js';
import type { VaultIdentity } from './memory/vault.js';
import type { Message } from './router/types.js';
import type { AriesConfig } from './config/types.js';
import { assembleWarmContext } from './memory/warmContext.js';
import { setupReplBridge, type ReplHandle } from './repl/setup.js';
import { registerReplTool } from './tools/registry.js';
import { checkForUpdate, getLocalVersion } from './update/check.js';
import { printUpdateNotification } from './update/notify.js';
import type { UpdateResult } from './update/check.js';

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

// Register cleanup for all exit paths
process.on('exit', exitParchment);
process.on('SIGINT', () => { exitParchment(); process.exit(0); });
process.on('SIGTERM', () => { exitParchment(); process.exit(0); });

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
    const idxResult = await replHandle.bridge.index({ repoPath: options.cwd });
    if (idxResult.ok) {
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
  ori --model opus         Use a specific model slot
  ori -c                   Continue most recent session
  ori -r                   Resume a session (interactive picker)
  ori -r "title"           Resume session by title or ID

${chalk.dim('Options:')}
  -m, --model <slot>       Model slot: primary, reasoning, cheap, bulk
  -c, --continue           Continue most recent session
  -r, --resume [query]     Resume session by ID, title, or number
  -n, --name <title>       Name this session
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
  /help                    Show commands
  /exit                    Exit
`);
    process.exit(0);
  } else if (args[i] === '--version') {
    console.log(getLocalVersion());
    process.exit(0);
  } else if (args[i] === '--read-only') {
    readOnlyMode = true;
  } else if (args[i] === '--max-turns') {
    maxTurns = parseInt(args[++i], 10);
  } else if (!args[i].startsWith('-')) {
    promptArg = args[i];
  }
}

const config = loadConfig(cwd);
process.env.TZ = config.timezone;
const isSubagent = process.env.ARIES_SUBAGENT === '1';

// Fire update check early — non-blocking, resolves in background
const updateCheckPromise: Promise<UpdateResult | null> = isSubagent
  ? Promise.resolve(null)
  : checkForUpdate().catch(() => null);

const detection = detectExistingSetup(cwd, config.vault.path);
if (!isSubagent && detection.isFirstRun) {
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
if (vaultPath) {
  vault = new OriVault(vaultPath);
  try {
    await vault.connect();
    vaultIdentity = await vault.loadIdentity();
    const status = await vault.status();
    vaultNoteCount = status?.noteCount;
    if (!isSubagent) {
      console.log(chalk.dim(`Vault: ${vaultPath} (${vaultNoteCount ?? '?'} notes)`));
    }

    try {
      const orientResult = await vault.orient() as { data?: { summary?: string } } | null;
      if (!isSubagent && orientResult?.data?.summary) {
        console.log(chalk.dim(`  ${orientResult.data.summary.split('\n')[0]}`));
      }
    } catch {
      // non-fatal
    }
  } catch {
    if (!isSubagent) {
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
  if (!isSubagent && projectBrain.count > 0) {
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

const router = new ModelRouter(config.models, config.experimental, config.features);
let replHandleRef: ReplHandle | null = null;

// Resolve 'auto': enable REPL only if the active model is capable
const replEnabled = config.repl.enabled === 'auto'
  ? isReplCapableModel(router.info.model)
  : config.repl.enabled;

const registry = createCoreRegistry({ replEnabled, webSearch: config.webSearch, getHandle: () => replHandleRef });
registerMemoryTools(registry, vault, projectBrain);

if (replEnabled) {
  registerReplTool(registry, () => replHandleRef);
}

const warmContext = await assembleWarmContext(vault, vaultIdentity);
if (!isSubagent && warmContext) {
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

if (isSubagent) {
  if (!promptArg) {
    process.stderr.write('Subagent requires a prompt argument\n');
    process.exit(1);
  }

  let subCodebaseSignatureMd: string | undefined;
  let subVaultSignatureMd: string | undefined;
  // Use shouldIndexCodebase so the subagent's mini-bridge respects the same
  // vault-only collision rule as the main bridge. Without this, a subagent
  // launched while cwd == vault would re-trigger markdown-as-code indexing
  // on every fork.
  const isProject = shouldIndexCodebase(cwd, vaultPath ?? undefined);

  if (config.signature.includeInSubagents && replEnabled) {
    let subRepl: ReplHandle | null = null;
    try {
      const rlm = resolveRlmConfig(config.repl.rlmModel);
      subRepl = await setupReplBridge({
        config: config.repl,
        cwd,
        vaultPath: vaultPath ?? undefined,
        rlmApiKey: rlm.rlmApiKey,
        rlmBaseUrl: rlm.rlmBaseUrl,
        rlmModel: rlm.rlmModel,
        vault,
        shouldIndex: isProject,
        trimVaultReturns: config.signature.trimVaultReturns,
      });
      if (subRepl) {
        const sigs = await compileAmbientSignatures(subRepl, {
          cwd,
          vaultPath: vaultPath ?? undefined,
          signature: config.signature,
        });
        subCodebaseSignatureMd = sigs.codebaseSignatureMd;
        subVaultSignatureMd = sigs.vaultSignatureMd;
      }
    } catch {
      // Fresh-context fallback is intentional.
    } finally {
      if (subRepl) await subRepl.shutdown();
    }
  }

  const subagentSystemPrompt = buildSystemPrompt({
    cwd,
    config,
    vaultPath: vaultPath ?? undefined,
    vaultNoteCount,
    projectBrainCount: projectBrain?.count,
    vaultIdentity,
    warmContext,
    codebaseSignature: subCodebaseSignatureMd,
    vaultSignature: subVaultSignatureMd,
    replEnabled: false,
    experienceLog: readExperienceLog(cwd),
  });

  const { agentLoop } = await import('./loop.js');
  const messages: Message[] = [{ role: 'user', content: promptArg }];
  let finalText = '';
  // Capture the last successful Repl output as a fallback channel. A subagent
  // that does all its work via Repl + done(value) emits zero assistant-text
  // events — finalText stays empty and the parent would see "(no output)."
  // The Repl tool_result's output_full contains say() narration (Batch 1.6
  // dual-write echoes say() into the exec-captured stdout) plus any print()
  // output, so surfacing the last non-error Repl output gives the parent
  // the subagent's actual work. See Batch 1.8 — this is the structural
  // companion to fixing vault.top's snippet lie: both are "the harness
  // isn't surfacing what it claims to surface" bugs.
  let lastReplOutputFull = '';

  for await (const event of agentLoop({
    messages,
    systemPrompt: subagentSystemPrompt,
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
    if (event.type === 'text') finalText += event.content;
    if (event.type === 'tool_result' && event.name === 'Repl' && !event.isError) {
      const full = event.output_full ?? event.output;
      if (full && full.trim()) lastReplOutputFull = full;
    }
    if (event.type === 'error') {
      const msg = event.error instanceof Error ? event.error.message : String(event.error);
      process.stderr.write(`Subagent error: ${msg}\n`);
    }
  }

  // Prefer assistant-text as the summary channel when present; fall back to
  // the last Repl output so codemode-native subagents (all work in Repl,
  // final commit via done()) still surface their work to the parent.
  const subagentOutput = finalText.trim() ? finalText : lastReplOutputFull;
  process.stdout.write(subagentOutput);
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
    }),
    { exitOnCtrlC: false },
  );

  // ── REPL bridge setup (background — doesn't block input) ──────────
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
          const parts: string[] = [config.repl.sandbox];
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

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err);
  exitParchment();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason);
});

main().catch((err) => {
  logCrash('main.catch', err);
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});



