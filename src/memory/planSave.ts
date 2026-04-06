/**
 * Save a plan to the chosen destination.
 *
 * Plans are valuable artifacts — the thinking that produced the code.
 * Three save targets:
 * - project: .aries/plans/<slug>.md — lives with the codebase, version controlled
 * - brain: .aries/memory/ — searchable by preflight next session
 * - vault: Ori vault — permanent, cross-project
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OriVault } from './vault.js';
import type { ProjectBrain } from './projectBrain.js';
import type { PlanSaveTarget } from '../ui/planExitDialog.js';

export interface PlanArtifact {
  summary: string;
  fullText: string;
  timestamp: number;
}

/**
 * Save a plan to the specified target.
 * Returns the path/title where it was saved, or null on failure.
 */
export async function savePlan(
  plan: PlanArtifact,
  target: PlanSaveTarget,
  cwd: string,
  vault: OriVault | null,
  projectBrain: ProjectBrain | null,
): Promise<string | null> {
  const date = new Date().toISOString().split('T')[0];
  const slug = plan.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');

  switch (target) {
    case 'project': {
      // Save to .aries/plans/<slug>.md
      const plansDir = join(cwd, '.aries', 'plans');
      mkdirSync(plansDir, { recursive: true });
      const filename = `${date}-${slug || 'plan'}.md`;
      const filepath = join(plansDir, filename);

      const content = [
        `# Plan: ${plan.summary}`,
        ``,
        `Date: ${date}`,
        ``,
        `---`,
        ``,
        plan.fullText,
      ].join('\n');

      writeFileSync(filepath, content, 'utf-8');
      return filepath;
    }

    case 'brain': {
      // Save to project brain (searchable by preflight)
      if (projectBrain) {
        projectBrain.save(
          `plan: ${plan.summary}`,
          plan.fullText.slice(0, 2000),
          'decision',
        );
        return `plan: ${plan.summary}`;
      }
      return null;
    }

    case 'vault': {
      // Save to Ori vault (permanent, cross-project)
      if (vault?.connected) {
        const success = await vault.add(
          `plan: ${plan.summary}`,
          plan.fullText.slice(0, 3000),
          'decision',
        );
        return success ? `plan: ${plan.summary}` : null;
      }
      return null;
    }

    case 'none':
      return null;
  }
}
