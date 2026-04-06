import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

export type AnthropicLocalOAuthStage = 'load' | 'refresh' | 'persist';

export class AnthropicLocalOAuthError extends Error {
  readonly stage: AnthropicLocalOAuthStage;

  constructor(stage: AnthropicLocalOAuthStage, message: string) {
    super(message);
    this.name = 'AnthropicLocalOAuthError';
    this.stage = stage;
  }
}

interface CredentialFileShape {
  claudeAiOauth?: Partial<OAuthCredentials>;
}

interface TokenResponseShape {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

interface AnthropicLocalOAuthSourceOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class AnthropicLocalOAuthSource {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: AnthropicLocalOAuthSourceOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  label(): string {
    return 'local Claude subscription';
  }

  loadCredentials(): OAuthCredentials {
    const manualToken = this.env.ANTHROPIC_OAUTH_TOKEN;
    if (manualToken) {
      return {
        accessToken: manualToken,
        refreshToken: '',
        expiresAt: this.now() + 86_400_000,
        scopes: ['user:inference'],
        subscriptionType: 'unknown',
        rateLimitTier: 'default',
      };
    }

    let sawMalformedFile = false;
    let lastMalformedReason = '';

    for (const credPath of this.getCredentialPaths()) {
      if (!existsSync(credPath)) continue;

      try {
        const raw = readFileSync(credPath, 'utf-8');
        const data = JSON.parse(raw) as CredentialFileShape;
        const oauth = data.claudeAiOauth;

        if (!oauth) {
          sawMalformedFile = true;
          lastMalformedReason = `${credPath} is missing claudeAiOauth`;
          continue;
        }
        if (!oauth.accessToken) {
          sawMalformedFile = true;
          lastMalformedReason = `${credPath} is missing claudeAiOauth.accessToken`;
          continue;
        }

        return {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken ?? '',
          expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : this.now() + 3_600_000,
          scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === 'string') : [],
          subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : 'unknown',
          rateLimitTier: typeof oauth.rateLimitTier === 'string' ? oauth.rateLimitTier : 'default',
        };
      } catch (err) {
        sawMalformedFile = true;
        lastMalformedReason = `${credPath} could not be parsed: ${(err as Error).message}`;
      }
    }

    if (sawMalformedFile) {
      throw new AnthropicLocalOAuthError(
        'load',
        `Failed to load local Claude credentials: ${lastMalformedReason}`,
      );
    }

    throw new AnthropicLocalOAuthError(
      'load',
      'Local Claude subscription mode requires Claude credentials on this machine. Run Claude once to authenticate, or set ANTHROPIC_OAUTH_TOKEN.',
    );
  }

  isExpired(creds: OAuthCredentials, bufferMs = 300_000): boolean {
    return this.now() >= (creds.expiresAt - bufferMs);
  }

  async refreshToken(creds: OAuthCredentials): Promise<OAuthCredentials> {
    if (!creds.refreshToken) {
      throw new AnthropicLocalOAuthError(
        'refresh',
        'OAuth token is expired and no refresh token is available.',
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl('https://console.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new AnthropicLocalOAuthError(
        'refresh',
        `Token refresh request failed: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new AnthropicLocalOAuthError(
        'refresh',
        `Token refresh failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }

    let data: TokenResponseShape;
    try {
      data = await response.json() as TokenResponseShape;
    } catch (err) {
      throw new AnthropicLocalOAuthError(
        'refresh',
        `Token refresh returned invalid JSON: ${(err as Error).message}`,
      );
    }

    if (!data.access_token || typeof data.expires_in !== 'number') {
      throw new AnthropicLocalOAuthError(
        'refresh',
        'Token refresh response is missing access_token or expires_in.',
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: this.now() + (data.expires_in * 1000),
      scopes: data.scope?.split(' ').filter(Boolean) ?? creds.scopes,
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier,
    };
  }

  persistCredentials(creds: OAuthCredentials): void {
    const credPath = this.getCredentialPaths()[0]!;

    try {
      mkdirSync(join(this.homeDir, '.claude'), { recursive: true });

      let data: Record<string, unknown> = {};
      if (existsSync(credPath)) {
        data = JSON.parse(readFileSync(credPath, 'utf-8')) as Record<string, unknown>;
      }

      data.claudeAiOauth = creds;

      const tmpPath = credPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, credPath);
    } catch (err) {
      throw new AnthropicLocalOAuthError(
        'persist',
        `Failed to persist refreshed credentials: ${(err as Error).message}`,
      );
    }
  }

  async ensureFreshToken(creds?: OAuthCredentials): Promise<OAuthCredentials> {
    const current = creds ?? this.loadCredentials();
    if (!this.isExpired(current)) return current;

    const refreshed = await this.refreshToken(current);
    this.persistCredentials(refreshed);
    return refreshed;
  }

  private getCredentialPaths(): string[] {
    return [
      join(this.homeDir, '.claude', '.credentials.json'),
      join(this.homeDir, '.claude', 'credentials.json'),
    ];
  }
}

export function loadAnthropicLocalOAuthCredentials(options?: AnthropicLocalOAuthSourceOptions): OAuthCredentials {
  return new AnthropicLocalOAuthSource(options).loadCredentials();
}

export function isAnthropicLocalOAuthExpired(
  creds: OAuthCredentials,
  bufferMs = 300_000,
  options?: AnthropicLocalOAuthSourceOptions,
): boolean {
  return new AnthropicLocalOAuthSource(options).isExpired(creds, bufferMs);
}

export async function refreshAnthropicLocalOAuthToken(
  creds: OAuthCredentials,
  options?: AnthropicLocalOAuthSourceOptions,
): Promise<OAuthCredentials> {
  return new AnthropicLocalOAuthSource(options).refreshToken(creds);
}

export function persistAnthropicLocalOAuthCredentials(
  creds: OAuthCredentials,
  options?: AnthropicLocalOAuthSourceOptions,
): void {
  new AnthropicLocalOAuthSource(options).persistCredentials(creds);
}
