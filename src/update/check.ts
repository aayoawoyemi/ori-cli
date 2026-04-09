import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PACKAGE_NAME = '@orimnemos/cli';
const CACHE_DIR = join(homedir(), '.aries');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 1500;

export interface UpdateResult {
  current: string;
  latest: string;
  outdated: boolean;
}

interface CacheEntry {
  latest: string;
  checked: number;
}

export function getLocalVersion(): string {
  const pkgPath = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

function readCache(): CacheEntry | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (typeof data.latest === 'string' && typeof data.checked === 'number') {
      return data as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(entry));
  } catch {
    // non-fatal
  }
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (l[i] ?? 0)) return false;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateResult | null> {
  const current = getLocalVersion();

  // Check cache first
  const cached = readCache();
  if (cached && Date.now() - cached.checked < CHECK_INTERVAL_MS) {
    return {
      current,
      latest: cached.latest,
      outdated: isNewer(cached.latest, current),
    };
  }

  // Fetch latest from npm registry
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch(
      `https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
      { signal: controller.signal },
    );
    clearTimeout(timeout);

    if (!res.ok) return null;

    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return null;

    writeCache({ latest, checked: Date.now() });

    return {
      current,
      latest,
      outdated: isNewer(latest, current),
    };
  } catch {
    return null;
  }
}
