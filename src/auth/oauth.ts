import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Types ───────────────────────────────────────────────────────────────────

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

// ── Token Retrieval ─────────────────────────────────────────────────────────

/**
 * Load OAuth credentials from Claude Code's credential store.
 *
 * Locations checked:
 * 1. ANTHROPIC_OAUTH_TOKEN env var (manual override)
 * 2. ~/.claude/.credentials.json (Windows/Linux)
 * 3. macOS Keychain via `security` command (future)
 */
export function loadOAuthCredentials(): OAuthCredentials | null {
  // 1. Environment variable override
  if (process.env.ANTHROPIC_OAUTH_TOKEN) {
    return {
      accessToken: process.env.ANTHROPIC_OAUTH_TOKEN,
      refreshToken: '',
      expiresAt: Date.now() + 86400_000, // assume 24h
      scopes: ['user:inference'],
      subscriptionType: 'unknown',
      rateLimitTier: 'default',
    };
  }

  // 2. Claude Code credentials file
  const home = homedir();
  const credPaths = [
    join(home, '.claude', '.credentials.json'),
    join(home, '.claude', 'credentials.json'),
  ];

  for (const credPath of credPaths) {
    if (existsSync(credPath)) {
      try {
        const raw = readFileSync(credPath, 'utf-8');
        const data = JSON.parse(raw) as {
          claudeAiOauth?: OAuthCredentials;
        };

        if (data.claudeAiOauth?.accessToken) {
          return data.claudeAiOauth;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Check if OAuth token is expired or close to expiry.
 */
export function isTokenExpired(creds: OAuthCredentials, bufferMs = 300_000): boolean {
  return Date.now() >= (creds.expiresAt - bufferMs);
}

/**
 * Refresh the OAuth token using the refresh token.
 * Returns new credentials or null if refresh fails.
 */
export async function refreshOAuthToken(creds: OAuthCredentials): Promise<OAuthCredentials | null> {
  if (!creds.refreshToken) return null;

  try {
    const response = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + (data.expires_in * 1000),
      scopes: data.scope?.split(' ') ?? creds.scopes,
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
    };
  } catch {
    return null;
  }
}
