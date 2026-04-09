import chalk from 'chalk';
import type { UpdateResult } from './check.js';

export function printUpdateNotification(result: UpdateResult | null): void {
  if (!result?.outdated) return;

  const msg = `Update available: ${chalk.dim(result.current)} → ${chalk.green(result.latest)}  —  npm i -g @orimnemos/cli`;
  console.log(`  ${chalk.yellow('⬆')}  ${msg}`);
}
