#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { loadConfig } from './config/load.js';
import { ModelRouter } from './router/index.js';
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
import { resolvePreflightEnabled } from './memory/preflight.js';

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
  const { existsSync } = require('node:fs');
  const { join } = require('node:path');
  return PROJECT_MARKERS.some(marker => existsSync(join(dir, marker)));
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

  // Skip codebase indexing if cwd isn't a project directory
  if (!isProjectDirectory(options.cwd)) {
    options.log?.('codebase signature: skipped (no project detected)');
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
    console.log('0.1.0');
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
session.createMeta(config.models.primary.model, sessionName);
session.log({
  type: 'meta',
  model: config.models.primary.model,
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

const router = new ModelRouter(config.models, config.experimental);
const registry = createCoreRegistry({ replEnabled: config.repl.enabled, webSearch: config.webSearch });
registerMemoryTools(registry, vault, projectBrain);

let replHandleRef: ReplHandle | null = null;
if (config.repl.enabled) {
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

  if (config.signature.includeInSubagents && config.repl.enabled) {
    let subRepl: ReplHandle | null = null;
    try {
      subRepl = await setupReplBridge({
        config: config.repl,
        cwd,
        vaultPath: vaultPath ?? undefined,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        rlmModel: config.models.primary.model,
        vault,
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
    preflightEnabled: resolvePreflightEnabled(config.preflight, config.repl.enabled),
  })) {
    if (event.type === 'text') finalText += event.content;
    if (event.type === 'error') {
      const msg = event.error instanceof Error ? event.error.message : String(event.error);
      process.stderr.write(`Subagent error: ${msg}\n`);
    }
  }

  process.stdout.write(finalText);
  vault?.disconnect();
  process.exit(0);
}

async function main(): Promise<void> {
  const modelInfo = router.info;
  const authMode = config.models.primary.auth === 'oauth'
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

  const vaultLabel = vault?.connected
    ? `~/${vault.vaultPath?.split(/[/\\]/).pop() ?? 'brain'}`
    : '';
  const infoParts = [
    'v1.0-beta.2',
    agentLabel !== 'Ori' ? agentLabel : null,
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
    console.log(`  ${brightGold('○')}  ${chalk.dim('v1.0-beta.2')}  ${chalk.hex('#c4a46c')('type /setup to configure your vault')}`);
  } else {
    console.log(`  ${brightGold('○')}  ${infoLine}`);
  }
  console.log('');

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
    replEnabled: config.repl.enabled, // declare intent — REPL tool is registered even before bridge is ready
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
      preflightEnabled: resolvePreflightEnabled(config.preflight, config.repl.enabled),
      resumedMessages,
      initialResumePicker: resumeArg === '',
    }),
    { exitOnCtrlC: false },
  );

  // ── REPL bridge setup (background — doesn't block input) ──────────
  if (config.repl.enabled) {
    (async () => {
      try {
        const anthropicKey = process.env.ANTHROPIC_API_KEY;
        const handle = await setupReplBridge({
          config: config.repl,
          cwd,
          vaultPath: vaultPath ?? undefined,
          anthropicApiKey: anthropicKey,
          rlmModel: config.models.primary.model,
          vault,
          onEvent: (e) => {
            if (e.type === 'bridge_restart' || e.type === 'bridge_error') {
              console.error(chalk.yellow(`  [repl] ${e.type}`));
            }
          },
        });
        replHandleRef = handle;

        if (handle) {
          const parts: string[] = [config.repl.sandbox];
          if (vaultPath) parts.push('vault');
          if (anthropicKey) parts.push('rlm');
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



