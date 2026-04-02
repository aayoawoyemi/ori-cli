#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
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

// ── Parse CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const cwd = resolve(process.cwd());

let modelOverride: string | undefined;
let promptArg: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--model' || args[i] === '-m') {
    modelOverride = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
${chalk.bold('Ori CLI')} — Memory-native coding agent

${chalk.dim('Usage:')}
  aries                    Start interactive session
  aries "prompt here"      Single prompt, then interactive
  aries --model opus       Use a specific model slot

${chalk.dim('Options:')}
  -m, --model <slot>       Model slot: primary, reasoning, cheap, bulk
  -h, --help               Show this help
  --version                Show version

${chalk.dim('In-session commands:')}
  /model <slot>            Switch model for next turn
  /cost                    Show token usage
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
  } else if (!args[i].startsWith('-')) {
    promptArg = args[i];
  }
}

// ── Initialize ──────────────────────────────────────────────────────────────

const config = loadConfig(cwd);

// ── Onboarding check ────────────────────────────────────────────────────────
const detection = detectExistingSetup(cwd, config.vault.path);

if (detection.isFirstRun) {
  const result = await runOnboarding();
  config.agent.name = result.agentName;
  if (result.vaultPath) {
    config.vault.path = result.vaultPath;
  }
}

// ── Vault connection ────────────────────────────────────────────────────────
let vault: OriVault | null = null;
let vaultIdentity: VaultIdentity | null = null;
let vaultNoteCount: number | undefined;

const vaultPath = config.vault.path || findVault();
if (vaultPath) {
  vault = new OriVault(vaultPath);
  try {
    await vault.connect();
    // Load identity from vault for system prompt
    vaultIdentity = await vault.loadIdentity();
    const status = await vault.status();
    vaultNoteCount = status?.noteCount;
    console.log(chalk.dim(`Vault: ${vaultPath} (${vaultNoteCount ?? '?'} notes)`));
  } catch (err) {
    console.log(chalk.dim(`Vault: ${vaultPath} (connection failed — running without vault)`));
    vault = null;
  }
}

// ── Project brain ───────────────────────────────────────────────────────────
let projectBrain: ProjectBrain | null = null;
if (config.projectBrain.enabled) {
  projectBrain = new ProjectBrain(cwd);
  projectBrain.init();
  projectBrain.load();
  if (projectBrain.count > 0) {
    console.log(chalk.dim(`Project brain: ${projectBrain.count} memories`));
  }
}

// ── Session storage ─────────────────────────────────────────────────────────
const session = new SessionStorage(cwd);
session.log({
  type: 'meta',
  model: config.models.primary.model,
  vault: vaultPath ?? null,
  cwd,
  agentName: config.agent.name,
  timestamp: Date.now(),
});

// ── Router + Registry ───────────────────────────────────────────────────────
const router = new ModelRouter(config.models);
const registry = createCoreRegistry();
registerMemoryTools(registry, vault, projectBrain);

// ── System prompt (frozen for session) ──────────────────────────────────────
const systemPrompt = buildSystemPrompt({
  cwd,
  config,
  vaultPath: vaultPath ?? undefined,
  vaultNoteCount,
  projectBrainCount: projectBrain?.count,
  vaultIdentity,
});

if (modelOverride) {
  try {
    router.setModel(modelOverride);
  } catch {
    console.error(chalk.red(`Unknown model: ${modelOverride}. Available: ${ModelRouter.availableModels.join(', ')}`));
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modelInfo = router.info;
  const authMode = config.models.primary.auth === 'oauth' ? 'OAuth' : 'API key';

  // ── Boot screen (before Ink takes over) ─────────────────────────────
  const agentLabel = vaultIdentity?.identity ? config.agent.name : 'Ori';
  console.log('');
  console.log(chalk.bold(`  Ori CLI`) + chalk.dim(` v0.1.0`) + (agentLabel !== 'Ori' ? chalk.dim(` · agent: ${agentLabel}`) : ''));
  console.log(chalk.dim(`  ${modelInfo.model} · ${authMode}`));
  console.log(chalk.dim(`  ${cwd}`));

  if (vault?.connected) {
    console.log(chalk.dim(`  Vault: ${vault.vaultPath} (${vaultNoteCount ?? '?'} notes)`));
  }
  if (projectBrain && projectBrain.count > 0) {
    console.log(chalk.dim(`  Brain: ${projectBrain.count} project memories`));
  }
  console.log('');

  // ── Render Ink app ──────────────────────────────────────────────────
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
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
  vault?.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(chalk.red(`Fatal: ${err.message}`));
  process.exit(1);
});
