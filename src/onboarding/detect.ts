import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findVault } from '../memory/vault.js';

export interface DetectionResult {
  hasVault: boolean;
  vaultPath: string | null;
  hasProjectBrain: boolean;
  isFirstRun: boolean;
}

/**
 * Detect existing vault and project brain.
 * If a vault exists (from Ori MCP or a previous CLI setup), skip onboarding.
 * Only trigger onboarding when there's no vault AND no global config.
 */
export function detectExistingSetup(cwd: string, configVaultPath?: string): DetectionResult {
  const vaultPath = findVault(configVaultPath);
  const hasVault = vaultPath !== null;
  const hasProjectBrain = existsSync(join(cwd, '.aries', 'memory'));

  // First run = no vault anywhere (not from Ori MCP, not from previous CLI setup)
  // AND no global config file
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const hasGlobalConfig = existsSync(join(home, '.aries', 'config.yaml'));
  const isFirstRun = !hasVault && !hasGlobalConfig;

  return { hasVault, vaultPath, hasProjectBrain, isFirstRun };
}
