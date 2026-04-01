import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

export interface OnboardingResult {
  agentName: string;
  vaultPath: string | null;
  userDescription: string | null;
}

/**
 * First-run onboarding flow.
 * "Who am I to you?" — the user names their agent and defines the relationship.
 */
export async function runOnboarding(): Promise<OnboardingResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  console.log(chalk.bold('\n  Welcome to Aries.\n'));

  // ── Name the agent ──────────────────────────────────────────────────
  const nameInput = await ask(
    chalk.dim('  Before we start — who am I to you?\n') +
    chalk.dim('  Give me a name (Enter for "Aries"): '),
  );
  const agentName = nameInput.trim() || 'Aries';

  // ── Who are you? ────────────────────────────────────────────────────
  console.log('');
  const userInput = await ask(
    chalk.dim('  And who are you? What should I know about\n') +
    chalk.dim('  you and how we\'ll work together?\n') +
    chalk.dim('  (Skip with Enter — I\'ll learn as we go.)\n\n') +
    chalk.dim('  > '),
  );
  const userDescription = userInput.trim() || null;

  // ── Vault setup ─────────────────────────────────────────────────────
  console.log('');
  const vaultInput = await ask(
    chalk.dim(`  Got it. I'm ${agentName}.\n\n`) +
    chalk.dim('  Persistent memory lets me remember across sessions\n') +
    chalk.dim('  and projects. Set up a vault? [y/n] '),
  );

  let vaultPath: string | null = null;

  if (vaultInput.trim().toLowerCase() === 'y' || vaultInput.trim().toLowerCase() === 'yes') {
    const defaultVaultPath = join(homedir(), '.aries', 'vault');
    console.log('');
    const pathInput = await ask(
      chalk.dim(`  Where? (${defaultVaultPath}) `),
    );
    vaultPath = pathInput.trim() || defaultVaultPath;

    // Create vault directory structure
    try {
      mkdirSync(join(vaultPath, 'self'), { recursive: true });
      mkdirSync(join(vaultPath, 'notes'), { recursive: true });
      mkdirSync(join(vaultPath, 'inbox'), { recursive: true });
      mkdirSync(join(vaultPath, 'ops'), { recursive: true });
      mkdirSync(join(vaultPath, '.ori'), { recursive: true });

      // Seed identity
      const identityContent = `# ${agentName}

Agent identity for ${agentName}. Created during first-run onboarding.

## Core
- Name: ${agentName}
- Role: Memory-native coding agent
`;
      writeFileSync(join(vaultPath, 'self', 'identity.md'), identityContent, 'utf-8');

      // Seed user model
      if (userDescription) {
        const userModelContent = `# User Model

${userDescription}
`;
        writeFileSync(join(vaultPath, 'self', 'user-model.md'), userModelContent, 'utf-8');
      }

      // Seed empty goals
      writeFileSync(join(vaultPath, 'self', 'goals.md'), '# Goals\n\n(Updated automatically as we work together.)\n', 'utf-8');

      console.log(chalk.dim(`\n  Vault created at ${vaultPath}`));
    } catch (err) {
      console.log(chalk.red(`\n  Failed to create vault: ${(err as Error).message}`));
      vaultPath = null;
    }
  }

  // ── Save global config ──────────────────────────────────────────────
  const globalConfigDir = join(homedir(), '.aries');
  mkdirSync(globalConfigDir, { recursive: true });

  const configContent = `# Aries CLI configuration
agent:
  name: ${agentName}
${vaultPath ? `\nvault:\n  path: ${vaultPath}\n  preflight: true\n  postflight: true` : ''}
`;

  const configPath = join(globalConfigDir, 'config.yaml');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, configContent, 'utf-8');
  }

  console.log(chalk.dim('\n  Ready.\n'));
  rl.close();

  return { agentName, vaultPath, userDescription };
}
