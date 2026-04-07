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

  try {
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
const registry = createCoreRegistry({ replEnabled: config.repl.enabled });
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
  // ── Ori elephant (downscaled from ori-website/dist/elephant.png at W=30) ──
  const warm = chalk.ansi256(178);  // antique gold
  const sprite = [
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
  const authLabel = config.models.primary.auth === 'oauth'
    ? (config.experimental.localClaudeSubscription ? 'Claude Max' : 'OAuth')
    : 'API key';
  const vaultLabel = vault?.connected ? `~/${vault.vaultPath?.split(/[/\\]/).pop() ?? 'brain'}` : '';
  const infoLines = [
    `${chalk.bold('Ori CLI')} ${chalk.dim('v0.1.0')}`,
    `${modelInfo.model}`,
    `${authLabel}${agentLabel !== 'Ori' ? ` · ${agentLabel}` : ''}`,
    vaultLabel,
  ].filter(Boolean);

  // Print sprite on left, info on right (info starts ~halfway down the elephant)
  console.log('');
  const infoStartLine = Math.max(0, Math.floor(sprite.length / 2) - Math.floor(infoLines.length / 2));
  for (let i = 0; i < sprite.length; i++) {
    const art = warm(sprite[i]!);
    const infoIdx = i - infoStartLine;
    const info = infoIdx >= 0 && infoIdx < infoLines.length
      ? (infoIdx === 0 ? infoLines[infoIdx] : chalk.dim(infoLines[infoIdx]))
      : '';
    console.log(`  ${art}  ${info ?? ''}`);
  }
  console.log('');

  let replHandle: ReplHandle | null = null;
  let codebaseSignatureMd: string | undefined;
  let vaultSignatureMd: string | undefined;

  if (config.repl.enabled) {
    try {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      replHandle = await setupReplBridge({
        config: config.repl,
        cwd,
        vaultPath: vaultPath ?? undefined,
        anthropicApiKey: anthropicKey,
        rlmModel: config.models.primary.model,
        onEvent: (e) => {
          if (e.type === 'bridge_restart' || e.type === 'bridge_error') {
            console.error(chalk.yellow(`  [repl] ${e.type}`));
          }
        },
      });
      replHandleRef = replHandle;

      if (replHandle) {
        const parts: string[] = [config.repl.sandbox];
        if (vaultPath) parts.push('vault');
        if (anthropicKey) parts.push('rlm');
        console.log(chalk.dim(`  repl: body ready (${parts.join(' + ')})`));

        const sigs = await compileAmbientSignatures(replHandle, {
          cwd,
          vaultPath: vaultPath ?? undefined,
          signature: config.signature,
          log: (line, isError) => {
            const msg = chalk.dim(`  ${line}`);
            if (isError) console.error(chalk.yellow(msg));
            else console.log(msg);
          },
        });
        codebaseSignatureMd = sigs.codebaseSignatureMd;
        vaultSignatureMd = sigs.vaultSignatureMd;
      }
    } catch (err) {
      console.error(chalk.yellow(`  repl: disabled (${(err as Error).message})`));
      replHandle = null;
      replHandleRef = null;
    }
  }

  const systemPrompt = buildSystemPrompt({
    cwd,
    config,
    vaultPath: vaultPath ?? undefined,
    vaultNoteCount,
    projectBrainCount: projectBrain?.count,
    vaultIdentity,
    warmContext,
    codebaseSignature: codebaseSignatureMd,
    vaultSignature: vaultSignatureMd,
    replEnabled: !!replHandle,
  });

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
      replHandle,
      preflightEnabled: resolvePreflightEnabled(config.preflight, config.repl.enabled),
      resumedMessages,
      initialResumePicker: resumeArg === '',
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  vault?.disconnect();
  if (replHandle) await replHandle.shutdown();
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



