// Drive auth, factory and drive:check. Every test uses a temp repo root with
// synthetic secrets, never the real .env or secrets/, and makes no call to
// Google (token exchange is stubbed; the loopback test talks to 127.0.0.1).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveCheck } from '../src/cli/drive-check';
import { ConfigError, loadConfig } from '../src/config';
import { DRIVE_SCOPE, getDriveAuth, loopbackConsent, readOAuthClient, readToken } from '../src/drive/auth';
import { FakeDriveClient } from '../src/drive/fake';
import { createDriveClient } from '../src/drive/factory';
import { GoogleDriveClient } from '../src/drive/google';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clearance-drive-auth-'));
  mkdirSync(join(root, 'secrets'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const secret = (name: string) => join(root, 'secrets', name);
const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v));
const cfg = (env: Record<string, string>) =>
  loadConfig({ repoRoot: root, env: { GDRIVE_ROOT_FOLDER_ID: 'folder-synthetic-1', ...env } });

const CLIENT = {
  installed: {
    client_id: 'synthetic-client.apps.googleusercontent.com',
    client_secret: 'synthetic-client-value',
    redirect_uris: ['http://localhost'],
  },
};
const SA_KEY = { type: 'service_account', client_email: 'sa@synthetic.iam.gserviceaccount.com', private_key: 'synthetic' };

describe('config paths', () => {
  it('uses repo-root secrets/ for the client JSON, token and key', () => {
    const d = cfg({}).requireDrive();
    expect(d.oauthClientPath).toBe(secret('gdrive-oauth-client.json'));
    expect(d.tokenPath).toBe(secret('gdrive-token.json'));
    expect(d.serviceAccountPath).toBe(secret('gdrive-sa.json'));
  });
});

describe('service account', () => {
  it('builds GoogleAuth with the drive scope from secrets/gdrive-sa.json', async () => {
    writeJson(secret('gdrive-sa.json'), SA_KEY);
    const auth = await getDriveAuth(cfg({ GDRIVE_AUTH: 'service-account' }).requireDrive());
    expect(auth).toBeInstanceOf(google.auth.GoogleAuth);
    // Private fields, read only to check what was configured.
    const ga = auth as unknown as { keyFilename: string; scopes: string[] };
    expect(ga.keyFilename).toBe(secret('gdrive-sa.json'));
    expect(ga.scopes).toEqual([DRIVE_SCOPE]);
  });

  it('refuses clearly when the key is missing or not a service account key', async () => {
    const d = cfg({ GDRIVE_AUTH: 'service-account' }).requireDrive();
    await expect(getDriveAuth(d)).rejects.toThrow(ConfigError);
    await expect(getDriveAuth(d)).rejects.toThrow(/Service account key not found at .*gdrive-sa\.json/);
    writeJson(secret('gdrive-sa.json'), CLIENT);
    await expect(getDriveAuth(d)).rejects.toThrow(/not a service account key/);
  });
});

describe('oauth', () => {
  it('refuses clearly when the client JSON is missing, malformed or a web client', async () => {
    const d = cfg({}).requireDrive();
    await expect(getDriveAuth(d)).rejects.toThrow(/OAuth client JSON not found at .*gdrive-oauth-client\.json/);
    writeFileSync(secret('gdrive-oauth-client.json'), 'not json');
    await expect(getDriveAuth(d)).rejects.toThrow(/not a JSON object/);
    writeJson(secret('gdrive-oauth-client.json'), { web: CLIENT.installed });
    await expect(getDriveAuth(d)).rejects.toThrow(/Desktop app/);
  });

  it('reads the installed client', () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    expect(readOAuthClient(secret('gdrive-oauth-client.json'))).toEqual({
      clientId: CLIENT.installed.client_id,
      clientSecret: CLIENT.installed.client_secret,
    });
  });

  it('refuses without a cached token unless interactive', async () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    const consent = vi.fn();
    await expect(getDriveAuth(cfg({}).requireDrive(), { getConsentCode: consent })).rejects.toThrow(
      /No Drive OAuth token at .*gdrive-token\.json.*npm run drive:check/,
    );
    expect(consent).not.toHaveBeenCalled();
  });

  it('uses the cached token and writes refreshed tokens back, keeping the refresh token', async () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    writeJson(secret('gdrive-token.json'), { refresh_token: 'r-1', access_token: 'a-1', expiry_date: 1 });
    const consent = vi.fn();
    const auth = await getDriveAuth(cfg({}).requireDrive(), { getConsentCode: consent, interactive: true });
    expect(consent).not.toHaveBeenCalled();
    expect(auth).toBeInstanceOf(google.auth.OAuth2);
    const client = auth as InstanceType<typeof google.auth.OAuth2>;
    expect(client.credentials.refresh_token).toBe('r-1');
    client.emit('tokens', { access_token: 'a-2', expiry_date: 2 });
    expect(readToken(secret('gdrive-token.json'))).toEqual({ refresh_token: 'r-1', access_token: 'a-2', expiry_date: 2 });
  });

  it('runs the loopback consent once with PKCE and the drive scope, then caches the token', async () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    const getToken = vi
      .spyOn(google.auth.OAuth2.prototype, 'getToken')
      .mockImplementation((async () => ({ tokens: { refresh_token: 'r-new', access_token: 'a-new' }, res: null })) as never);
    let authUrl = '';
    const consent = vi.fn(async (req: { authUrl(r: string): string; state: string }) => {
      authUrl = req.authUrl('http://127.0.0.1:5555');
      return { code: 'code-123', redirectUri: 'http://127.0.0.1:5555' };
    });
    const logs: string[] = [];
    const auth = await getDriveAuth(cfg({}).requireDrive(), {
      interactive: true,
      getConsentCode: consent,
      log: (l) => logs.push(l),
    });
    expect(consent).toHaveBeenCalledOnce();
    const u = new URL(authUrl);
    expect(u.origin).toBe('https://accounts.google.com');
    expect(u.searchParams.get('scope')).toBe(DRIVE_SCOPE);
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('client_id')).toBe(CLIENT.installed.client_id);
    const args = getToken.mock.calls[0]![0] as unknown as { code: string; codeVerifier: string; redirect_uri: string };
    expect(args).toMatchObject({ code: 'code-123', redirect_uri: 'http://127.0.0.1:5555' });
    expect(args.codeVerifier).toBeTruthy();
    expect(JSON.parse(readFileSync(secret('gdrive-token.json'), 'utf8'))).toEqual({
      refresh_token: 'r-new',
      access_token: 'a-new',
    });
    expect(statSync(secret('gdrive-token.json')).mode & 0o777).toBe(0o600);
    expect((auth as InstanceType<typeof google.auth.OAuth2>).credentials.refresh_token).toBe('r-new');
    expect(logs.some((l) => l.includes('Saved the Drive token'))).toBe(true);
  });

  it('refuses a corrupt token file clearly', async () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    writeFileSync(secret('gdrive-token.json'), '{oops');
    await expect(getDriveAuth(cfg({}).requireDrive())).rejects.toThrow(/not valid JSON/);
  });
});

describe('loopbackConsent', () => {
  const req = { state: 'state-abc', authUrl: (r: string) => `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${r}` };

  it('prints and opens the consent URL, then returns the code from the 127.0.0.1 redirect', async () => {
    const logs: string[] = [];
    let opened = '';
    const result = loopbackConsent(req, {
      log: (l) => logs.push(l),
      openBrowser: (url) => {
        opened = url;
        const redirect = new URL(url).searchParams.get('redirect_uri')!;
        void fetch(`${redirect}/?state=state-abc&code=the-code&scope=${encodeURIComponent(DRIVE_SCOPE)}`);
      },
    });
    const { code, redirectUri } = await result;
    expect(code).toBe('the-code');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(opened).toContain(redirectUri);
    expect(logs).toContain(opened);
  });

  it('rejects a mismatched state or a denied consent', async () => {
    const run = (query: string) =>
      loopbackConsent(req, {
        log: () => undefined,
        openBrowser: (url) => void fetch(`${new URL(url).searchParams.get('redirect_uri')}/?${query}`),
      });
    await expect(run('state=wrong&code=x')).rejects.toThrow(/mismatched state/);
    await expect(run('error=access_denied&state=state-abc')).rejects.toThrow(/access_denied/);
  });

  it('times out', async () => {
    await expect(loopbackConsent(req, { log: () => undefined, openBrowser: () => undefined, timeoutMs: 20 })).rejects.toThrow(
      /Timed out/,
    );
  });
});

describe('createDriveClient', () => {
  it('refuses clearly without GDRIVE_ROOT_FOLDER_ID', async () => {
    const config = loadConfig({ repoRoot: root, env: {} });
    await expect(createDriveClient({ config })).rejects.toThrow(/GDRIVE_ROOT_FOLDER_ID is not set/);
  });

  it('switches auth on GDRIVE_AUTH alone', async () => {
    writeJson(secret('gdrive-oauth-client.json'), CLIENT);
    writeJson(secret('gdrive-token.json'), { refresh_token: 'r-1' });
    writeJson(secret('gdrive-sa.json'), SA_KEY);
    const oauth = await createDriveClient({ config: cfg({ GDRIVE_AUTH: 'oauth' }) });
    const sa = await createDriveClient({ config: cfg({ GDRIVE_AUTH: 'service-account' }) });
    expect(oauth).toBeInstanceOf(GoogleDriveClient);
    expect(sa).toBeInstanceOf(GoogleDriveClient);
    expect(oauth.rootId).toBe('folder-synthetic-1');
    expect(sa.rootId).toBe('folder-synthetic-1');
  });

  it('passes the drive config and options to the auth factory', async () => {
    const authFactory = vi.fn(async () => new google.auth.OAuth2());
    await createDriveClient({ config: cfg({ GDRIVE_AUTH: 'service-account' }), authFactory, interactive: true });
    expect(authFactory).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'service-account', rootFolderId: 'folder-synthetic-1' }),
      expect.objectContaining({ interactive: true }),
    );
  });
});

describe('drive:check', () => {
  it('lists the root and ensures the subfolders, idempotently (fake Drive)', async () => {
    const fake = new FakeDriveClient('root-x');
    await fake.upload('01-a.txt', 'SPECIMEN');
    fake.addRootFolder('Unrelated');
    const logs: string[] = [];
    const first = await driveCheck(fake, (l) => logs.push(l));
    expect(first.rootFiles).toEqual(['01-a.txt']);
    expect(fake.snapshot()).toEqual({ root: ['01-a.txt'], legal: [], accounting: [], 'high-risk': [] });
    const second = await driveCheck(fake, () => undefined);
    expect(second.subfolders).toEqual(first.subfolders);
    expect(logs.join('\n')).toMatch(/Legal\/[\s\S]*Accounting\/[\s\S]*High Risk\/[\s\S]*drive:check OK/);
    expect(fake.outsideTreeIds()).toEqual([]);
  });
});
