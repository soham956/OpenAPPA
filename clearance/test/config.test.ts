import { mkdirSync, mkdtempSync,readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLEARANCE_DIR, ConfigError, REPO_ROOT, loadConfig } from '../src/config';

// Every test uses a temp repo root with synthetic values, never the real .env.
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clearance-config-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const writeEnv = (body: string) => writeFileSync(join(root, '.env'), body);

describe('config', () => {
  it('resolves the repo root as the parent of clearance/', () => {
    expect(join(REPO_ROOT, 'clearance')).toBe(CLEARANCE_DIR);
  });

  it('loads .env from the repo root and resolves secrets/ there', () => {
    writeEnv('GDRIVE_ROOT_FOLDER_ID=folder-synthetic-123\nTYPESAFE_API_KEY=test-key-not-real\n');
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(cfg.gdriveRootFolderId).toBe('folder-synthetic-123');
    expect(cfg.typesafeApiKey).toBe('test-key-not-real');
    expect(cfg.paths.envFile).toBe(join(root, '.env'));
    expect(cfg.paths.secretsDir).toBe(join(root, 'secrets'));
    expect(cfg.paths.oauthClient).toBe(join(root, 'secrets', 'gdrive-oauth-client.json'));
    expect(cfg.paths.oauthToken).toBe(join(root, 'secrets', 'gdrive-token.json'));
    expect(cfg.paths.serviceAccount).toBe(join(root, 'secrets', 'gdrive-sa.json'));
    expect(cfg.paths.clearanceDir).toBe(join(root, 'clearance'));
    expect(cfg.paths.decisionsLog).toBe(join(root, 'clearance', 'logs', 'decisions.jsonl'));
    expect(cfg.paths.appaDb).toBe(join(root, 'clearance', 'state', 'appa.db'));
  });

  it('does not read clearance/.env', () => {
    mkdirSync(join(root, 'clearance'));
    writeFileSync(join(root, 'clearance', '.env'), 'GDRIVE_ROOT_FOLDER_ID=wrong\n');
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(cfg.gdriveRootFolderId).toBeUndefined();
  });

  it('applies defaults when .env is missing', () => {
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(cfg.gdriveAuth).toBe('oauth');
    expect(cfg.classifierMode).toBe('replay');
    expect(cfg.confidenceThreshold).toBe(0.7);
    expect(cfg.appaBin).toBe('appa');
    expect(cfg.appaPort).toBe(8790);
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.requireAppa).toBe(false);
  });

  it('lets the real environment override .env', () => {
    writeEnv('APPA_PORT=9000\nCONFIDENCE_THRESHOLD=0.5\n');
    const cfg = loadConfig({ repoRoot: root, env: { APPA_PORT: '9100', APPA_BIN: '/opt/appa', CLEARANCE_REQUIRE_APPA: '1' } });
    expect(cfg.appaPort).toBe(9100);
    expect(cfg.confidenceThreshold).toBe(0.5);
    expect(cfg.appaBin).toBe('/opt/appa');
    expect(cfg.requireAppa).toBe(true);
  });

  it('treats empty values as unset', () => {
    writeEnv('GDRIVE_ROOT_FOLDER_ID=\nTYPESAFE_API_KEY=   \nAPPA_PORT=\n');
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(cfg.gdriveRootFolderId).toBeUndefined();
    expect(cfg.typesafeApiKey).toBeUndefined();
    expect(cfg.appaPort).toBe(8790);
  });

  it('requireDrive() throws a clear message when GDRIVE_ROOT_FOLDER_ID is unset', () => {
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(() => cfg.requireDrive()).toThrow(ConfigError);
    expect(() => cfg.requireDrive()).toThrow(/GDRIVE_ROOT_FOLDER_ID is not set.*repo-root \.env/);
  });

  it('requireDrive() returns the folder, auth mode and secret paths', () => {
    writeEnv('GDRIVE_ROOT_FOLDER_ID=folder-synthetic-123\nGDRIVE_AUTH=service-account\n');
    const drive = loadConfig({ repoRoot: root, env: {} }).requireDrive();
    expect(drive).toEqual({
      rootFolderId: 'folder-synthetic-123',
      auth: 'service-account',
      oauthClientPath: join(root, 'secrets', 'gdrive-oauth-client.json'),
      tokenPath: join(root, 'secrets', 'gdrive-token.json'),
      serviceAccountPath: join(root, 'secrets', 'gdrive-sa.json'),
    });
  });

  it('requireTypesafeKey() throws only when the key is needed and missing', () => {
    const cfg = loadConfig({ repoRoot: root, env: {} });
    expect(() => cfg.requireTypesafeKey()).toThrow(/TYPESAFE_API_KEY is not set/);
    expect(loadConfig({ repoRoot: root, env: { TYPESAFE_API_KEY: 'test-key' } }).requireTypesafeKey()).toBe('test-key');
  });

  it.each([
    ['GDRIVE_AUTH', 'magic', /GDRIVE_AUTH=magic is invalid/],
    ['CLASSIFIER_MODE', 'guess', /CLASSIFIER_MODE=guess is invalid/],
    ['CONFIDENCE_THRESHOLD', '1.5', /CONFIDENCE_THRESHOLD=1.5 is invalid/],
    ['APPA_PORT', 'abc', /APPA_PORT=abc is invalid/],
    ['POLL_INTERVAL_MS', '-5', /POLL_INTERVAL_MS=-5 is invalid/],
  ])('rejects invalid %s', (key, value, msg) => {
    expect(() => loadConfig({ repoRoot: root, env: { [key]: value } })).toThrow(msg);
  });

  it('.env.example lists every key, says to copy it to the repo root, and holds no secret values', () => {
    const example = readFileSync(join(CLEARANCE_DIR, '.env.example'), 'utf8');
    expect(example).toMatch(/repo root/i);
    const entries = Object.fromEntries(
      example
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    for (const key of [
      'TYPESAFE_API_KEY',
      'GDRIVE_ROOT_FOLDER_ID',
      'GDRIVE_AUTH',
      'CLASSIFIER_MODE',
      'CONFIDENCE_THRESHOLD',
      'APPA_BIN',
      'APPA_PORT',
      'POLL_INTERVAL_MS',
    ]) {
      expect(entries, key).toHaveProperty(key);
    }
    expect(entries.APPA_PORT).toBe('8790');
    expect(entries.TYPESAFE_API_KEY).toBe('');
    expect(entries.GDRIVE_ROOT_FOLDER_ID).toBe('');
  });
});
