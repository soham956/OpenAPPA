// Drive auth, chosen by GDRIVE_AUTH with no code change:
//   oauth            Desktop-app client JSON (secrets/gdrive-oauth-client.json).
//                    First run does a loopback consent and caches the token at
//                    secrets/gdrive-token.json; refreshed tokens are written back.
//   service-account  Key file at secrets/gdrive-sa.json.
// Paths come from config.requireDrive(); secrets/ lives at the repo root.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { type Auth, google } from 'googleapis';
import { ConfigError, type DriveConfig } from '../config';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
/** How long the loopback server waits for the browser consent. */
export const CONSENT_TIMEOUT_MS = 5 * 60_000;

export type DriveAuth = Auth.OAuth2Client | Auth.GoogleAuth;

export interface ConsentRequest {
  /** Build the Google consent URL for the given loopback redirect URI. */
  authUrl(redirectUri: string): string;
  /** Expected `state` echoed back on the redirect. */
  state: string;
}

export interface AuthOptions {
  /**
   * May we run the browser consent if there is no cached token? Only
   * `npm run drive:check` passes true; everything else refuses instead.
   */
  interactive?: boolean;
  /** Where progress lines go (default: stderr). */
  log?: (line: string) => void;
  /** Open a URL in the browser (default: the OS opener). Test seam. */
  openBrowser?: (url: string) => void;
  /** Run the loopback consent and return the code + redirect URI. Test seam. */
  getConsentCode?: (req: ConsentRequest) => Promise<{ code: string; redirectUri: string }>;
  /** Consent wait limit (default CONSENT_TIMEOUT_MS). */
  timeoutMs?: number;
}

const SETUP_HINT = 'See clearance/docs/drive-setup.md.';

/** Build the auth object for the configured GDRIVE_AUTH mode. */
export async function getDriveAuth(drive: DriveConfig, opts: AuthOptions = {}): Promise<DriveAuth> {
  return drive.auth === 'service-account' ? serviceAccountAuth(drive) : oauthAuth(drive, opts);
}

// ---- service account ----

export function serviceAccountAuth(drive: DriveConfig): Auth.GoogleAuth {
  const key = readJson(drive.serviceAccountPath, 'Service account key', 'GDRIVE_AUTH=service-account');
  if (key.type !== 'service_account' || typeof key.client_email !== 'string') {
    throw new ConfigError(
      `${drive.serviceAccountPath} is not a service account key (expected "type": "service_account" and "client_email"). ${SETUP_HINT}`,
    );
  }
  return new google.auth.GoogleAuth({ keyFile: drive.serviceAccountPath, scopes: [DRIVE_SCOPE] });
}

// ---- OAuth (Desktop app, loopback) ----

export interface InstalledClient {
  clientId: string;
  clientSecret: string;
}

/** Read the Desktop-app client JSON (top-level key `installed`). */
export function readOAuthClient(path: string): InstalledClient {
  const json = readJson(path, 'OAuth client JSON', 'GDRIVE_AUTH=oauth');
  const inst = json.installed as Record<string, unknown> | undefined;
  if (!inst || typeof inst.client_id !== 'string' || typeof inst.client_secret !== 'string') {
    const hint = json.web ? ' It is a "Web application" client; create a "Desktop app" client instead.' : '';
    throw new ConfigError(
      `${path} is not a Desktop-app OAuth client (expected a top-level "installed" key with client_id and client_secret).${hint} ${SETUP_HINT}`,
    );
  }
  return { clientId: inst.client_id, clientSecret: inst.client_secret };
}

export async function oauthAuth(drive: DriveConfig, opts: AuthOptions = {}): Promise<Auth.OAuth2Client> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const { clientId, clientSecret } = readOAuthClient(drive.oauthClientPath);
  const client = new google.auth.OAuth2({ clientId, clientSecret });

  let token = readToken(drive.tokenPath);
  if (!token) {
    if (!opts.interactive) {
      throw new ConfigError(
        `No Drive OAuth token at ${drive.tokenPath}. Run \`npm run drive:check\` once to sign in in the browser. ${SETUP_HINT}`,
      );
    }
    token = await runConsent(client, opts, log);
    writeToken(drive.tokenPath, token);
    log(`Saved the Drive token to ${drive.tokenPath}.`);
  }
  client.setCredentials(token);
  // Google sends the refresh_token only once, so merge refreshes into the cache.
  client.on('tokens', (fresh) => {
    const current = readToken(drive.tokenPath) ?? token ?? {};
    writeToken(drive.tokenPath, { ...current, ...fresh });
  });
  return client;
}

async function runConsent(
  client: Auth.OAuth2Client,
  opts: AuthOptions,
  log: (line: string) => void,
): Promise<Auth.Credentials> {
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');
  const req: ConsentRequest = {
    state,
    authUrl: (redirectUri) =>
      client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [DRIVE_SCOPE],
        state,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256' as Auth.CodeChallengeMethod,
      }),
  };
  const getCode =
    opts.getConsentCode ??
    ((r: ConsentRequest) =>
      loopbackConsent(r, { log, openBrowser: opts.openBrowser ?? openInBrowser, timeoutMs: opts.timeoutMs }));
  const { code, redirectUri } = await getCode(req);
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) {
    log('Warning: Google returned no refresh token; you may need to sign in again when this one expires.');
  }
  return tokens;
}

/**
 * Listen on 127.0.0.1 on a random port, print and open the consent URL, and
 * resolve with the code from the redirect. Rejects on a denied consent, a
 * state mismatch or the timeout.
 */
export function loopbackConsent(
  req: ConsentRequest,
  opts: { log: (line: string) => void; openBrowser: (url: string) => void; timeoutMs?: number },
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    let timer: NodeJS.Timeout | undefined;
    const server = createServer((httpReq, res) => {
      const url = new URL(httpReq.url ?? '/', redirectUri);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      const ok = !!code && url.searchParams.get('state') === req.state;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(ok ? 'Clearance is signed in to Google Drive. You can close this tab.' : 'Sign-in failed. Check the terminal.');
      finish(
        ok
          ? undefined
          : new ConfigError(
              error ? `Google sign-in was not completed: ${error}.` : 'Google sign-in returned a mismatched state; try again.',
            ),
        code ?? '',
      );
    });
    const finish = (err: Error | undefined, code = '') => {
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (err) reject(err);
      else resolve({ code, redirectUri });
    };
    server.on('error', (e) => finish(e));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}`;
      const url = req.authUrl(redirectUri);
      opts.log('Sign in to Google Drive in your browser. If it does not open, visit:');
      opts.log(url);
      try {
        opts.openBrowser(url);
      } catch {
        // The printed URL is the fallback.
      }
      timer = setTimeout(
        () => finish(new ConfigError('Timed out waiting for Google sign-in in the browser.')),
        opts.timeoutMs ?? CONSENT_TIMEOUT_MS,
      );
    });
  });
}

/** Open a URL with the OS default browser; failures are ignored. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}

// ---- token cache ----

export function readToken(path: string): Auth.Credentials | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const t = JSON.parse(readFileSync(path, 'utf8')) as Auth.Credentials;
    return t && (t.refresh_token || t.access_token) ? t : undefined;
  } catch {
    throw new ConfigError(`The Drive token at ${path} is not valid JSON. Delete it and run \`npm run drive:check\` again.`);
  }
}

export function writeToken(path: string, token: Auth.Credentials): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJson(path: string, what: string, mode: string): Record<string, unknown> {
  if (!existsSync(path)) {
    throw new ConfigError(`${what} not found at ${path} (needed for ${mode}). ${SETUP_HINT}`);
  }
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ConfigError(`${what} at ${path} is not a JSON object. ${SETUP_HINT}`);
}
