// `npm run reset` and `npm run drop` (demo steps 0 and 3).
// reset: refuse while the sidecar answers /health, archive logs/ to runs/<stamp>/,
// clear runtime state, then put the Drive tree back to "01–10 in the root,
// three empty subfolders". drop: upload seed/new/11-* to the root.
// Drive access goes only through DriveClient, so nothing outside the tree is touched.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Config, Paths } from '../config';
import { createDriveClient } from '../drive/factory';
import { type DriveClient, type DriveFile, FOLDER_KEYS } from '../drive/types';
import { LOOPBACK } from '../sidecar/runtime';

/** Creates the real DriveClient. The CLIs take one so tests can inject the fake. */
export type DriveFactory = (cfg: Config) => Promise<DriveClient>;

/** The live Google DriveClient, non-interactive (no browser consent; run `npm run drive:check` first). */
export const liveDriveFactory: DriveFactory = (config) => createDriveClient({ config });

export class ResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetRefusedError';
  }
}

export type ResetPaths = Pick<
  Paths,
  'seedDir' | 'newSeedDir' | 'logsDir' | 'runsDir' | 'stateDir' | 'appaDb' | 'memoryFile' | 'pollerState' | 'decisionsLog' | 'outboxLog'
>;

export interface ResetDeps {
  drive: DriveClient;
  paths: ResetPaths;
  /** Base URL of the sidecar, e.g. http://127.0.0.1:8790. */
  sidecarUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface ResetResult {
  trashed: number;
  uploaded: string[];
  /** runs/<stamp> the old logs went to, or undefined when there was nothing to archive. */
  archivedTo: string | undefined;
  deletedState: string[];
}

/** The sidecar URL reset checks: the configured port on loopback. */
export function sidecarUrlFor(cfg: Pick<Config, 'appaPort'>): string {
  return `http://${LOOPBACK}:${cfg.appaPort}`;
}

/** True when anything answers GET <url>/health. A refused or timed-out connection is false. */
export async function sidecarAnswers(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    return true;
  } catch {
    return false;
  }
}

const SEED_RE = /^(0[1-9]|10)-.+\.txt$/;
const NEW_SEED_RE = /^11-.+\.txt$/;

function seedFiles(dir: string, re: RegExp, expected?: number): string[] {
  const names = existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n) && statSync(join(dir, n)).isFile()).sort() : [];
  if (names.length === 0 || (expected !== undefined && names.length !== expected)) {
    throw new Error(`Expected ${expected ?? 'at least 1'} seed file(s) matching ${re} in ${dir}, found ${names.length}.`);
  }
  return names;
}

/** File-system-safe UTC stamp, e.g. 2026-10-19T13-29-36-123Z. */
export function runStamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Move logs/ to runs/<stamp>/ when it holds any non-empty file. Leaves an
 * empty logs/ with empty decisions.jsonl and outbox.jsonl.
 */
export function archiveLogs(paths: ResetPaths, now: Date): string | undefined {
  let archivedTo: string | undefined;
  if (existsSync(paths.logsDir)) {
    const hasContent = readdirSync(paths.logsDir).some((n) => {
      const s = statSync(join(paths.logsDir, n));
      return s.isDirectory() || s.size > 0;
    });
    if (hasContent) {
      mkdirSync(paths.runsDir, { recursive: true });
      const stamp = runStamp(now);
      archivedTo = join(paths.runsDir, stamp);
      for (let i = 2; existsSync(archivedTo); i++) archivedTo = join(paths.runsDir, `${stamp}-${i}`);
      renameSync(paths.logsDir, archivedTo);
    } else {
      rmSync(paths.logsDir, { recursive: true, force: true });
    }
  }
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.decisionsLog, '');
  writeFileSync(paths.outboxLog, '');
  return archivedTo;
}

/** Delete state/appa.db* (db, -wal, -shm, -journal), memory.json and poller.json. */
export function clearState(paths: ResetPaths): string[] {
  const deleted: string[] = [];
  const dbName = basename(paths.appaDb);
  if (existsSync(paths.stateDir)) {
    for (const n of readdirSync(paths.stateDir)) {
      if (n === dbName || n.startsWith(`${dbName}-`)) deleted.push(join(paths.stateDir, n));
    }
  }
  for (const f of [paths.memoryFile, paths.pollerState]) if (existsSync(f)) deleted.push(f);
  for (const f of deleted) rmSync(f, { force: true });
  return deleted;
}

/**
 * Trash every file in the root and the three subfolders, ensure the subfolders,
 * and upload seed 01–10 to the root. Folders in the root that are not Clearance
 * subfolders can't be listed through DriveClient and are left alone.
 */
export async function resetDrive(drive: DriveClient, seedDir: string): Promise<{ trashed: number; uploaded: string[] }> {
  const seeds = seedFiles(seedDir, SEED_RE, 10).map((n) => ({ name: n, content: readFileSync(join(seedDir, n), 'utf8') }));
  await drive.ensureSubfolders();
  let trashed = 0;
  for (const folder of FOLDER_KEYS) {
    for (const f of await drive.list(folder)) {
      await drive.trash(f.id);
      trashed++;
    }
  }
  const uploaded: string[] = [];
  for (const s of seeds) uploaded.push((await drive.upload(s.name, s.content, 'root')).name);
  return { trashed, uploaded };
}

export async function reset(deps: ResetDeps): Promise<ResetResult> {
  const log = deps.log ?? (() => {});
  if (await sidecarAnswers(deps.sidecarUrl, deps.fetchImpl)) {
    throw new ResetRefusedError(
      `Refusing to reset: something answers ${deps.sidecarUrl}/health. Stop \`npm start\` (the appa sidecar) first.`,
    );
  }
  const archivedTo = archiveLogs(deps.paths, (deps.now ?? (() => new Date()))());
  log(archivedTo ? `archived logs/ to ${archivedTo}` : 'logs/ was empty; nothing to archive');
  const deletedState = clearState(deps.paths);
  log(`cleared ${deletedState.length} state file(s)`);
  const { trashed, uploaded } = await resetDrive(deps.drive, deps.paths.seedDir);
  log(`Drive: trashed ${trashed} file(s), uploaded ${uploaded.length} seed file(s) to the root`);
  return { trashed, uploaded, archivedTo, deletedState };
}

/** Upload seed/new/11-* to the Drive root (demo step 3). */
export async function drop(deps: { drive: DriveClient; paths: Pick<Paths, 'newSeedDir'> }): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  for (const n of seedFiles(deps.paths.newSeedDir, NEW_SEED_RE)) {
    out.push(await deps.drive.upload(n, readFileSync(join(deps.paths.newSeedDir, n), 'utf8'), 'root'));
  }
  return out;
}
