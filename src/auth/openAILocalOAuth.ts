import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface OpenAIOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  lastRefresh: string;
}

export type OpenAILocalOAuthStage = 'load' | 'refresh' | 'persist';

export class OpenAILocalOAuthError extends Error {
  readonly stage: OpenAILocalOAuthStage;

  constructor(stage: OpenAILocalOAuthStage, message: string) {
    super(message);
    this.name = 'OpenAILocalOAuthError';
    this.stage = stage;
  }
}

interface CodexAuthFileShape {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface TokenResponseShape {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface OpenAILocalOAuthSourceOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OpenAILocalOAuthSource {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: OpenAILocalOAuthSourceOptions = {}) {
    this.env = options.env ?? process.env;
    this.homeDir = options.homeDir ?? homedir();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  label(): string {
    return 'local ChatGPT subscription';
  }

  loadCredentials(): OpenAIOAuthCredentials {
    // Env override — accepts a raw access token
    const manualToken = this.env.OPENAI_OAUTH_TOKEN;
    if (manualToken) {
      return {
        accessToken: manualToken,
        refreshToken: '',
        idToken: '',
        accountId: '',
        lastRefresh: new Date(this.now()).toISOString(),
      };
    }

    const credPath = this.getCredentialPath();

    if (!existsSync(credPath)) {
      throw new OpenAILocalOAuthError(
        'load',
        'Local ChatGPT subscription mode requires Codex credentials on this machine. Run "codex" once to authenticate, or set OPENAI_OAUTH_TOKEN.',
      );
    }

    let data: CodexAuthFileShape;
    try {
      data = JSON.parse(readFileSync(credPath, 'utf-8')) as CodexAuthFileShape;
    } catch (err) {
      throw new OpenAILocalOAuthError(
        'load',
        `Failed to parse ${credPath}: ${(err as Error).message}`,
      );
    }

    // Prefer a plain API key if present
    if (data.OPENAI_API_KEY) {
      return {
        accessToken: data.OPENAI_API_KEY,
        refreshToken: '',
        idToken: '',
        accountId: '',
        lastRefresh: new Date(this.now()).toISOString(),
      };
    }

    const tokens = data.tokens;
    if (!tokens?.access_token) {
      throw new OpenAILocalOAuthError(
        'load',
        `${credPath} is missing tokens.access_token`,
      );
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? '',
      idToken: tokens.id_token ?? '',
      accountId: tokens.account_id ?? '',
      lastRefresh: data.last_refresh ?? new Date(this.now()).toISOString(),
    };
  }

  /**
   * Decode the JWT expiry from the access token.
   * Returns true if the token is expired (or within bufferMs of expiry).
   */
  isExpired(creds: OpenAIOAuthCredentials, bufferMs = 300_000): boolean {
    if (!creds.accessToken) return true;

    try {
      const parts = creds.accessToken.split('.');
      if (parts.length !== 3) return false; // not a JWT — assume valid (API key path)

      const payload = JSON.parse(
        Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
      ) as { exp?: number };

      if (typeof payload.exp !== 'number') return false;
      return this.now() >= (payload.exp * 1000 - bufferMs);
    } catch {
      return false;
    }
  }

  async refreshToken(creds: OpenAIOAuthCredentials): Promise<OpenAIOAuthCredentials> {
    if (!creds.refreshToken) {
      throw new OpenAILocalOAuthError(
        'refresh',
        'OAuth token is expired and no refresh token is available.',
      );
    }

    let response: Response;
    try {
      response = await this.fetchImpl('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new OpenAILocalOAuthError(
        'refresh',
        `Token refresh request failed: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new OpenAILocalOAuthError(
        'refresh',
        `Token refresh failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
      );
    }

    let data: TokenResponseShape;
    try {
      data = await response.json() as TokenResponseShape;
    } catch (err) {
      throw new OpenAILocalOAuthError(
        'refresh',
        `Token refresh returned invalid JSON: ${(err as Error).message}`,
      );
    }

    if (!data.access_token) {
      throw new OpenAILocalOAuthError(
        'refresh',
        'Token refresh response is missing access_token.',
      );
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      idToken: data.id_token ?? creds.idToken,
      accountId: creds.accountId,
      lastRefresh: new Date(this.now()).toISOString(),
    };
  }

  persistCredentials(creds: OpenAIOAuthCredentials): void {
    const credPath = this.getCredentialPath();

    try {
      mkdirSync(join(this.homeDir, '.codex'), { recursive: true });

      let data: CodexAuthFileShape = {};
      if (existsSync(credPath)) {
        data = JSON.parse(readFileSync(credPath, 'utf-8')) as CodexAuthFileShape;
      }

      data.tokens = {
        ...data.tokens,
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
        id_token: creds.idToken,
        account_id: creds.accountId,
      };
      data.last_refresh = creds.lastRefresh;

      const tmpPath = credPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      renameSync(tmpPath, credPath);
    } catch (err) {
      throw new OpenAILocalOAuthError(
        'persist',
        `Failed to persist refreshed credentials: ${(err as Error).message}`,
      );
    }
  }

  async ensureFreshToken(creds?: OpenAIOAuthCredentials): Promise<OpenAIOAuthCredentials> {
    const current = creds ?? this.loadCredentials();
    if (!this.isExpired(current)) return current;

    const refreshed = await this.refreshToken(current);
    this.persistCredentials(refreshed);
    return refreshed;
  }

  private getCredentialPath(): string {
    return join(this.homeDir, '.codex', 'auth.json');
  }
}

// ── Convenience functions ──────────────────────────────────────────────────

export function loadOpenAILocalOAuthCredentials(options?: OpenAILocalOAuthSourceOptions): OpenAIOAuthCredentials {
  return new OpenAILocalOAuthSource(options).loadCredentials();
}

export function isOpenAILocalOAuthExpired(
  creds: OpenAIOAuthCredentials,
  bufferMs = 300_000,
  options?: OpenAILocalOAuthSourceOptions,
): boolean {
  return new OpenAILocalOAuthSource(options).isExpired(creds, bufferMs);
}

export async function refreshOpenAILocalOAuthToken(
  creds: OpenAIOAuthCredentials,
  options?: OpenAILocalOAuthSourceOptions,
): Promise<OpenAIOAuthCredentials> {
  return new OpenAILocalOAuthSource(options).refreshToken(creds);
}

export function persistOpenAILocalOAuthCredentials(
  creds: OpenAIOAuthCredentials,
  options?: OpenAILocalOAuthSourceOptions,
): void {
  new OpenAILocalOAuthSource(options).persistCredentials(creds);
}
