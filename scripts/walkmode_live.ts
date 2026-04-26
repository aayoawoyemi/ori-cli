/**
 * Headless walkmode verification.
 *
 * The normal `ori "prompt"` path renders Ink and requires a real TTY. Codex's
 * command runner is not a TTY, so this script exercises the same runtime core
 * directly: ModelRouter -> agentLoop -> ReplTool -> setupReplBridge -> Python
 * body/vault bridge. It is intentionally narrow and live: it calls the
 * configured model provider and connected vault.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { ModelRouter, isReplCapableModel } from '../src/router/index.js';
import { createCoreRegistry, registerMemoryTools, registerReplTool } from '../src/tools/registry.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { OriVault, findVault } from '../src/memory/vault.js';
import { ProjectBrain } from '../src/memory/projectBrain.js';
import { assembleWarmContext } from '../src/memory/warmContext.js';
import { readExperienceLog } from '../src/memory/experienceLog.js';
import { setupReplBridge, type ReplHandle } from '../src/repl/setup.js';
import { agentLoop } from '../src/loop.js';
import type { Message } from '../src/router/types.js';

const DEFAULT_PROMPT =
  'walk the codemode paradigm region in my brain — find the top hit, read it, and tell me its thesis in one sentence';

function parseArgs(argv: string[]): { model?: string; effort?: 'high' | 'medium' | 'low'; prompt: string } {
  const out: { model?: string; effort?: 'high' | 'medium' | 'low'; prompt: string } = {
    prompt: DEFAULT_PROMPT,
  };
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '--model' || argv[i] === '-m') && argv[i + 1]) {
      out.model = argv[++i];
    } else if ((argv[i] === '--effort' || argv[i] === '-e') && argv[i + 1]) {
      const effort = argv[++i];
      if (effort !== 'high' && effort !== 'medium' && effort !== 'low') {
        throw new Error(`Invalid effort: ${effort}`);
      }
      out.effort = effort;
    } else if ((argv[i] === '--prompt' || argv[i] === '-p') && argv[i + 1]) {
      out.prompt = argv[++i];
    }
  }
  return out;
}

const PROJECT_MARKERS = [
  '.git', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'pom.xml', 'build.gradle', 'Makefile', 'CMakeLists.txt', '.project',
  'deno.json', 'composer.json', 'Gemfile', 'mix.exs', 'setup.py',
];

function isProjectDirectory(dir: string): boolean {
  const home = homedir();
  const resolved = resolve(dir);
  if (resolved === resolve(home)) return false;
  return PROJECT_MARKERS.some(marker => existsSync(join(dir, marker)));
}

function shouldIndexCodebase(cwd: string, vaultPath: string | undefined): boolean {
  if (!isProjectDirectory(cwd)) return false;
  if (vaultPath && resolve(cwd) === resolve(vaultPath)) return false;
  return true;
}

function resolveRlmConfig(configRlmModel: string | undefined): {
  rlmApiKey?: string;
  rlmBaseUrl?: string;
  rlmModel: string;
} {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (openrouterKey) {
    return {
      rlmApiKey: openrouterKey,
      rlmBaseUrl: 'https://openrouter.ai/api/v1',
      rlmModel: configRlmModel ?? 'openai/gpt-oss-20b',
    };
  }
  if (anthropicKey) {
    return {
      rlmApiKey: anthropicKey,
      rlmBaseUrl: 'https://api.anthropic.com/v1/',
      rlmModel: configRlmModel ?? 'claude-haiku-4-5-20251001',
    };
  }
  return { rlmModel: 'unset' };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(process.cwd());
  const config = loadConfig(cwd);
  process.env.TZ = config.timezone;

  let vault: OriVault | null = null;
  const vaultPath = config.vault.path || findVault();
  let vaultIdentity = null;
  let vaultNoteCount: number | undefined;
  if (vaultPath) {
    vault = new OriVault(vaultPath);
    await vault.connect();
    vaultIdentity = await vault.loadIdentity();
    vaultNoteCount = (await vault.status())?.noteCount;
  }

  const projectBrain = config.projectBrain.enabled ? new ProjectBrain(cwd) : null;
  if (projectBrain) {
    projectBrain.init();
    projectBrain.load();
  }

  const router = new ModelRouter(config.models, config.experimental, config.features);
  if (args.model) router.setModel(args.model);
  if (args.effort) router.setEffort(args.effort);
  const replEnabled = config.repl.enabled === 'auto'
    ? isReplCapableModel(router.info.model)
    : config.repl.enabled;
  if (!replEnabled) throw new Error(`Repl is not enabled for model ${router.info.model}`);

  let replHandle: ReplHandle | null = null;
  const registry = createCoreRegistry({
    replEnabled,
    webSearch: config.webSearch,
    getHandle: () => replHandle,
  });
  registerMemoryTools(registry, vault, projectBrain);
  registerReplTool(registry, () => replHandle);

  const rlm = resolveRlmConfig(config.repl.rlmModel);
  replHandle = await setupReplBridge({
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
    webSearchConfig: config.webSearch,
    onEvent: (e) => {
      if (e.type === 'bridge_error') {
        const error = 'error' in e ? e.error : '(no message)';
        console.error(`[bridge_error] ${error}`);
      } else if (e.type === 'bridge_restart') {
        console.error(`[bridge_restart] ${e.reason} attempt=${e.attempt}`);
      }
    },
  });
  if (!replHandle) throw new Error('Repl handle was not created');

  const warmContext = await assembleWarmContext(vault, vaultIdentity);
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
    replEnabled: true,
    experienceLog: readExperienceLog(cwd),
  });

  const messages: Message[] = [{ role: 'user', content: args.prompt }];
  let finalText = '';
  let replCalls = 0;
  let bridgeTimeouts = 0;

  try {
    for await (const event of agentLoop({
      messages,
      systemPrompt,
      router,
      registry,
      toolContext: { cwd },
      vault,
      projectBrain,
      session: null,
      hooks: config.hooks,
      permissionMode: 'accept',
      maxTurns: 8,
    })) {
      if (event.type === 'model_start') {
        console.log(`[model_start] turn=${event.turn} model=${event.model}`);
      } else if (event.type === 'text') {
        process.stdout.write(event.content);
        finalText += event.content;
      } else if (event.type === 'tool_call') {
        console.log(`\n[tool_call] ${event.toolCall.name}`);
      } else if (event.type === 'tool_result') {
        if (event.name === 'Repl') replCalls++;
        if (event.output_full?.includes('bridge request timed out')) bridgeTimeouts++;
        console.log(`\n[tool_result] ${event.name} isError=${event.isError}`);
        console.log((event.output_full ?? event.output).slice(0, 1200));
      } else if (event.type === 'error') {
        const msg = event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error);
        console.error(`\n[loop_error] ${msg}`);
      }
    }

    console.log('\n[summary]');
    console.log(`repl_calls=${replCalls}`);
    console.log(`bridge_timeouts=${bridgeTimeouts}`);
    console.log(`final_text=${JSON.stringify(finalText.trim())}`);
  } finally {
    await replHandle.shutdown();
    vault?.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
