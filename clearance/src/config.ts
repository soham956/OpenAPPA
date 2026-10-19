// Config loader. The .env file and secrets/ live at the REPO ROOT (one level
// above clearance/), never inside clearance/. Real environment variables win
// over values in .env. Owned by T1.1; changes go back to the orchestrator.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

/** Absolute path of the clearance/ package. */
export const CLEARANCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Absolute path of the repo root (holds .env and secrets/). */
export const REPO_ROOT = resolve(CLEARANCE_DIR, '..');

export const GDRIVE_AUTH_MODES = ['oauth', 'service-account'] as const;
export type GdriveAuth = (typeof GDRIVE_AUTH_MODES)[number];

export const CLASSIFIER_MODES = ['replay', 'live'] as const;
export type ClassifierMode = (typeof CLASSIFIER_MODES)[number];

export const DEFAULTS = {
  GDRIVE_AUTH: 'oauth',
  CLASSIFIER_MODE: 'replay',
  CONFIDENCE_THRESHOLD: 0.7,
  APPA_BIN: 'appa',
  APPA_PORT: 8790,
  POLL_INTERVAL_MS: 10_000,
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface DriveConfig {
  rootFolderId: string;
  auth: GdriveAuth;
  /** OAuth Desktop client JSON (GDRIVE_AUTH=oauth). */
  oauthClientPath: string;
  /** Cached OAuth token (GDRIVE_AUTH=oauth). */
  tokenPath: string;
  /** Service account key (GDRIVE_AUTH=service-account). */
  serviceAccountPath: string;
}

export interface Paths {
  repoRoot: string;
  clearanceDir: string;
  envFile: string;
  secretsDir: string;
  oauthClient: string;
  oauthToken: string;
  serviceAccount: string;
  stateDir: string;
  logsDir: string;
  runsDir: string;
  seedDir: string;
  newSeedDir: string;
  fixturesFile: string;
  appaConfig: string;
  appaDb: string;
  memoryFile: string;
  pollerState: string;
  decisionsLog: string;
  outboxLog: string;
}

export interface Config {
  paths: Paths;
  typesafeApiKey: string | undefined;
  gdriveRootFolderId: string | undefined;
  gdriveAuth: GdriveAuth;
  classifierMode: ClassifierMode;
  confidenceThreshold: number;
  appaBin: string;
  appaPort: number;
  pollIntervalMs: number;
  /** CLEARANCE_REQUIRE_APPA=1: live sidecar tests must run instead of skipping. */
  requireAppa: boolean;
  /** Drive settings; throws ConfigError if GDRIVE_ROOT_FOLDER_ID is unset. */
  requireDrive(): DriveConfig;
  /** The TypeSafe key; throws ConfigError if TYPESAFE_API_KEY is unset. */
  requireTypesafeKey(): string;
}

export interface LoadOptions {
  /** Repo root to read .env from and resolve secrets/ against. Default: REPO_ROOT. */
  repoRoot?: string;
  /** clearance/ dir for state/, logs/ etc. Default: <repoRoot>/clearance. */
  clearanceDir?: string;
  /** Environment that overrides .env. Default: process.env. */
  env?: Record<string, string | undefined>;
}

export function buildPaths(repoRoot: string, clearanceDir: string): Paths {
  const secretsDir = join(repoRoot, 'secrets');
  const stateDir = join(clearanceDir, 'state');
  const logsDir = join(clearanceDir, 'logs');
  return {
    repoRoot,
    clearanceDir,
    envFile: join(repoRoot, '.env'),
    secretsDir,
    oauthClient: join(secretsDir, 'gdrive-oauth-client.json'),
    oauthToken: join(secretsDir, 'gdrive-token.json'),
    serviceAccount: join(secretsDir, 'gdrive-sa.json'),
    stateDir,
    logsDir,
    runsDir: join(clearanceDir, 'runs'),
    seedDir: join(clearanceDir, 'seed'),
    newSeedDir: join(clearanceDir, 'seed', 'new'),
    fixturesFile: join(clearanceDir, 'fixtures', 'classifications.json'),
    appaConfig: join(clearanceDir, 'appa.toml'),
    appaDb: join(stateDir, 'appa.db'),
    memoryFile: join(stateDir, 'memory.json'),
    pollerState: join(stateDir, 'poller.json'),
    decisionsLog: join(logsDir, 'decisions.jsonl'),
    outboxLog: join(logsDir, 'outbox.jsonl'),
  };
}

/** Parse the .env file at `envFile`; a missing file yields {}. */
export function readEnvFile(envFile: string): Record<string, string> {
  return existsSync(envFile) ? parseDotenv(readFileSync(envFile)) : {};
}

const ENV_HINT = 'Set it in the repo-root .env (copy clearance/.env.example to ../.env).';

function str(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function oneOf<T extends string>(key: string, set: readonly T[], v: string | undefined, dflt: T): T {
  const s = str(v);
  if (s === undefined) return dflt;
  if ((set as readonly string[]).includes(s)) return s as T;
  throw new ConfigError(`${key}=${s} is invalid; expected one of: ${set.join(', ')}.`);
}

function num(key: string, v: string | undefined, dflt: number, check: (n: number) => boolean, want: string): number {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || !check(n)) throw new ConfigError(`${key}=${s} is invalid; expected ${want}.`);
  return n;
}

/** Load config from <repoRoot>/.env overlaid with `env`. Pure: never mutates process.env. */
export function loadConfig(opts: LoadOptions = {}): Config {
  const repoRoot = resolve(opts.repoRoot ?? REPO_ROOT);
  const clearanceDir = resolve(opts.clearanceDir ?? join(repoRoot, 'clearance'));
  const paths = buildPaths(repoRoot, clearanceDir);
  const merged: Record<string, string | undefined> = { ...readEnvFile(paths.envFile), ...stripUndefined(opts.env ?? process.env) };
  const get = (k: string) => str(merged[k]);

  const typesafeApiKey = get('TYPESAFE_API_KEY');
  const gdriveRootFolderId = get('GDRIVE_ROOT_FOLDER_ID');
  const gdriveAuth = oneOf('GDRIVE_AUTH', GDRIVE_AUTH_MODES, get('GDRIVE_AUTH'), DEFAULTS.GDRIVE_AUTH);

  return {
    paths,
    typesafeApiKey,
    gdriveRootFolderId,
    gdriveAuth,
    classifierMode: oneOf('CLASSIFIER_MODE', CLASSIFIER_MODES, get('CLASSIFIER_MODE'), DEFAULTS.CLASSIFIER_MODE),
    confidenceThreshold: num('CONFIDENCE_THRESHOLD', get('CONFIDENCE_THRESHOLD'), DEFAULTS.CONFIDENCE_THRESHOLD, (n) => n >= 0 && n <= 1, 'a number between 0 and 1'),
    appaBin: get('APPA_BIN') ?? DEFAULTS.APPA_BIN,
    appaPort: num('APPA_PORT', get('APPA_PORT'), DEFAULTS.APPA_PORT, (n) => Number.isInteger(n) && n > 0 && n < 65536, 'a TCP port (1-65535)'),
    pollIntervalMs: num('POLL_INTERVAL_MS', get('POLL_INTERVAL_MS'), DEFAULTS.POLL_INTERVAL_MS, (n) => Number.isInteger(n) && n > 0, 'a positive integer (milliseconds)'),
    requireAppa: ['1', 'true', 'yes'].includes((get('CLEARANCE_REQUIRE_APPA') ?? '').toLowerCase()),
    requireDrive(): DriveConfig {
      if (!gdriveRootFolderId) {
        throw new ConfigError(`GDRIVE_ROOT_FOLDER_ID is not set, so Drive can't be used. ${ENV_HINT}`);
      }
      return {
        rootFolderId: gdriveRootFolderId,
        auth: gdriveAuth,
        oauthClientPath: paths.oauthClient,
        tokenPath: paths.oauthToken,
        serviceAccountPath: paths.serviceAccount,
      };
    },
    requireTypesafeKey(): string {
      if (!typesafeApiKey) {
        throw new ConfigError(`TYPESAFE_API_KEY is not set, so Jev can't be called live. ${ENV_HINT}`);
      }
      return typesafeApiKey;
    },
  };
}

function stripUndefined(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

let cached: Config | undefined;

/** Process-wide config from the real repo-root .env and process.env (cached). */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}
