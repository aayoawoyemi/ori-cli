import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

export interface OnboardingResult {
  agentName: string;
  vaultPath: string | null;
  userDescription: string | null;
}

const gold = chalk.hex('#c4a46c');
const brightGold = chalk.hex('#d4aa55');
const dim = chalk.dim;

/**
 * First-run onboarding — create a vault via `ori init`.
 * Only runs when no existing vault is detected (from Ori MCP or otherwise).
 */
export async function runOnboarding(): Promise<OnboardingResult> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  // ── Welcome ─────────────────────────────────────────────────────────
  console.log('');
  console.log(gold('  ┌──────────────────────────────────────┐'));
  console.log(gold('  │') + chalk.bold('  Welcome to Ori CLI                 ') + gold('│'));
  console.log(gold('  │') + dim('  A coding agent with persistent memory') + gold('│'));
  console.log(gold('  └──────────────────────────────────────┘'));
  console.log('');
  console.log(dim('  Ori uses a vault — a folder of markdown files —'));
  console.log(dim('  to remember context across sessions and projects.'));
  console.log('');
  console.log(gold('     ┌─────────┐    ┌─────────┐    ┌─────────┐'));
  console.log(gold('     │ Ori CLI │    │ VS Code │    │ Cursor  │'));
  console.log(gold('     └────┬────┘    └────┬────┘    └────┬────┘'));
  console.log(gold('          │              │              │'));
  console.log(gold('          └──────────────┼──────────────┘'));
  console.log(gold('                         │'));
  console.log(gold('                   ┌─────┴─────┐'));
  console.log(gold('                   │') + brightGold('  Ori MCP  ') + gold('│'));
  console.log(gold('                   └─────┬─────┘'));
  console.log(gold('                         │'));
  console.log(gold('                    ┌────┴────┐'));
  console.log(gold('                    │') + brightGold(' vault/  ') + gold(' │'));
  console.log(gold('                    │') + dim(' notes/  ') + gold(' │'));
  console.log(gold('                    │') + dim(' self/   ') + gold(' │'));
  console.log(gold('                    │') + dim(' inbox/  ') + gold(' │'));
  console.log(gold('                    └─────────┘'));
  console.log('');
  console.log(dim('  One vault, many clients.'));
  console.log('');

  // ── Vault location ──────────────────────────────────────────────────
  const defaultVaultPath = join(homedir(), 'brain');

  const pathInput = await ask(
    dim(`  Vault location (${defaultVaultPath}): `),
  );
  const vaultPath = pathInput.trim() || defaultVaultPath;

  // ── Delegate to ori init ────────────────────────────────────────────
  // ori-memory is a dependency, so `ori` binary should be available.
  // `ori init` creates the vault from its scaffold (richer than manual mkdir).
  // We pass --json so it doesn't run its own interactive boot sequence.
  let oriInitSuccess = false;

  try {
    execSync(`ori init "${vaultPath}" --json`, {
      stdio: 'pipe',
      env: { ...process.env },
      timeout: 30_000,
    });
    oriInitSuccess = true;
    console.log('');
    console.log(gold('  ✓') + dim(` Vault created at ${vaultPath}`));
  } catch (err) {
    // Fallback: create minimal structure manually if ori binary fails
    console.log(dim(`\n  ori init failed, creating vault manually...`));
    try {
      mkdirSync(join(vaultPath, 'self'), { recursive: true });
      mkdirSync(join(vaultPath, 'notes'), { recursive: true });
      mkdirSync(join(vaultPath, 'inbox'), { recursive: true });
      mkdirSync(join(vaultPath, 'ops'), { recursive: true });
      mkdirSync(join(vaultPath, '.ori'), { recursive: true });
      writeFileSync(
        join(vaultPath, 'self', 'identity.md'),
        '# Ori\n\nAgent identity. Updated automatically.\n',
        'utf-8',
      );
      writeFileSync(
        join(vaultPath, 'self', 'goals.md'),
        '# Goals\n\n(Updated automatically as we work together.)\n',
        'utf-8',
      );
      oriInitSuccess = true;
      console.log(gold('  ✓') + dim(` Vault created at ${vaultPath}`));
    } catch (mkdirErr) {
      console.log(chalk.red(`  Failed to create vault: ${(mkdirErr as Error).message}`));
    }
  }

  // ── Save CLI config ─────────────────────────────────────────────────
  const globalConfigDir = join(homedir(), '.aries');
  mkdirSync(globalConfigDir, { recursive: true });

  const configContent = `# Ori CLI configuration
agent:
  name: Ori

vault:
  path: ${vaultPath}
  preflight: true
  postflight: true
`;

  const configPath = join(globalConfigDir, 'config.yaml');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, configContent, 'utf-8');
  }

  console.log('');
  rl.close();

  return { agentName: 'Ori', vaultPath: oriInitSuccess ? vaultPath : null, userDescription: null };
}
