import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AriesConfig } from './types.js';

/** Recursively interpolate ${ENV_VAR} references in string values. */
function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{(\w+)\}/g, (_, key) => process.env[key] ?? '');
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnv);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = interpolateEnv(v);
    }
    return result;
  }
  return obj;
}

/** Deep merge b into a. b wins on conflicts. */
function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  const result = { ...a } as Record<string, unknown>;
  for (const [key, val] of Object.entries(b)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

/**
 * Load configuration from (in priority order):
 * 1. Project .aries/config.yaml
 * 2. Global ~/.aries/config.yaml
 * 3. Built-in defaults
 */
export function loadConfig(cwd: string): AriesConfig {
  const globalPath = join(homedir(), '.aries', 'config.yaml');
  const projectPath = join(cwd, '.aries', 'config.yaml');

  let config = { ...DEFAULT_CONFIG } as Record<string, unknown>;

  // Global config
  if (existsSync(globalPath)) {
    try {
      const raw = parseYaml(readFileSync(globalPath, 'utf-8')) as Record<string, unknown>;
      const interpolated = interpolateEnv(raw) as Record<string, unknown>;
      config = deepMerge(config, interpolated);
    } catch {
      // Malformed config — use defaults
    }
  }

  // Project config (overrides global)
  if (existsSync(projectPath)) {
    try {
      const raw = parseYaml(readFileSync(projectPath, 'utf-8')) as Record<string, unknown>;
      const interpolated = interpolateEnv(raw) as Record<string, unknown>;
      config = deepMerge(config, interpolated);
    } catch {
      // Malformed config — use defaults
    }
  }

  return config as unknown as AriesConfig;
}

export type { AriesConfig } from './types.js';
