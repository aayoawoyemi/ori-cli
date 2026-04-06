import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import {
  AnthropicLocalOAuthSource,
  AnthropicLocalOAuthError,
} from '../src/auth/anthropicLocalOAuth.js';
import { AnthropicProvider } from '../src/router/providers/anthropic.js';

let failures = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aries-auth-test-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  return home;
}

await test('loads manual env token without touching disk', () => {
  const source = new AnthropicLocalOAuthSource({
    env: { ANTHROPIC_OAUTH_TOKEN: 'tok-manual' } as NodeJS.ProcessEnv,
    homeDir: makeTempHome(),
    now: () => 1_000,
  });

  const creds = source.loadCredentials();
  assert.equal(creds.accessToken, 'tok-manual');
  assert.equal(creds.refreshToken, '');
  assert.equal(creds.expiresAt, 86_401_000);
});

await test('refreshes expired credentials and persists them back to disk', async () => {
  const home = makeTempHome();
  const credPath = join(home, '.claude', '.credentials.json');
  writeFileSync(credPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'expired',
      refreshToken: 'refresh-me',
      expiresAt: 1_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default',
    },
  }, null, 2));

  const source = new AnthropicLocalOAuthSource({
    env: {} as NodeJS.ProcessEnv,
    homeDir: home,
    now: () => 10_000,
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
        scope: 'user:inference offline_access',
      }),
      text: async () => '',
    })) as typeof fetch,
  });

  const current = source.loadCredentials();
  const refreshed = await source.ensureFreshToken(current);
  assert.equal(refreshed.accessToken, 'fresh-token');
  assert.equal(refreshed.refreshToken, 'fresh-refresh');
  assert.deepEqual(refreshed.scopes, ['user:inference', 'offline_access']);

  const persisted = JSON.parse(readFileSync(credPath, 'utf-8'));
  assert.equal(persisted.claudeAiOauth.accessToken, 'fresh-token');
  assert.equal(persisted.claudeAiOauth.refreshToken, 'fresh-refresh');
});

await test('surfaces malformed credential files as load-stage errors', () => {
  const home = makeTempHome();
  const credPath = join(home, '.claude', '.credentials.json');
  writeFileSync(credPath, '{not-json');

  const source = new AnthropicLocalOAuthSource({ homeDir: home, env: {} as NodeJS.ProcessEnv });
  assert.throws(() => source.loadCredentials(), (err: unknown) => {
    assert.ok(err instanceof AnthropicLocalOAuthError);
    assert.equal(err.stage, 'load');
    assert.match(err.message, /could not be parsed/i);
    return true;
  });
});

await test('anthropic provider rejects oauth mode unless the experimental gate is enabled', () => {
  assert.throws(() => new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    auth: 'oauth',
  }), /experimental\.localClaudeSubscription/);
});

if (failures > 0) {
  process.exit(1);
}
