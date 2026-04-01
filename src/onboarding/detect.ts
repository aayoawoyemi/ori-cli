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
 * Used to decide whether to run onboarding.
 */
export function detectExistingSetup(cwd: string, configVaultPath?: string): DetectionResult {
  const vaultPath = findVault(configVaultPath);
  const hasVault = vaultPath !== null;
  const hasProjectBrain = existsSync(join(cwd, '.aries', 'memory'));

  // First run = no vault AND no global config
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const hasGlobalConfig = existsSync(join(home, '.aries', 'config.yaml'));
  const isFirstRun = !hasVault && !hasGlobalConfig;

  return { hasVault, vaultPath, hasProjectBrain, isFirstRun };
}
