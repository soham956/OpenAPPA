import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main as dropMain } from '../src/cli/drop';
import { main as resetMain } from '../src/cli/reset';
import { CLEARANCE_DIR, ConfigError, buildPaths, loadConfig } from '../src/config';
import { FakeDriveClient } from '../src/drive/fake';
import { type ResetPaths, ResetRefusedError, drop, liveDriveFactory, reset, sidecarUrlFor } from '../src/reset/reset';

const SEED_DIR = join(CLEARANCE_DIR, 'seed');
const SEEDS = readdirSync(SEED_DIR).filter((n) => /^(0[1-9]|10)-.+\.txt$/.test(n)).sort();
const NEW_SEED = readdirSync(join(SEED_DIR, 'new')).find((n) => n.startsWith('11-'))!;

const down: typeof fetch = async () => {
  throw new TypeError('fetch failed: ECONNREFUSED');
};
const up: typeof fetch = async () => new Response('ok', { status: 200 });

let tmp: string;
let paths: ResetPaths;
let drive: FakeDriveClient;
let clock: number;
const now = () => new Date(Date.UTC(2026, 9, 19, 12, 0, 0) + clock++ * 1000);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clearance-reset-'));
  paths = { ...buildPaths(tmp, join(tmp, 'clearance')), seedDir: SEED_DIR, newSeedDir: join(SEED_DIR, 'new') };
  drive = new FakeDriveClient();
  clock = 0;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const run = () => reset({ drive, paths, sidecarUrl: 'http://127.0.0.1:8790', fetchImpl: down, now });

/** A Drive tree left over from a previous run, plus things outside the tree. */
async function dirtyDrive() {
  await drive.upload('01-mutual-nda-kestrel-orbit.txt', 'old', 'legal');
  await drive.upload('05-invoice-0193.txt', 'old', 'accounting');
  await drive.upload('08-employment-contract-r-okafor.txt', 'old', 'high-risk');
  await drive.upload('11-vendor-invoice-0207.txt', 'old', 'root');
  await drive.upload('stray-notes.txt', 'old', 'root');
  const outside = drive.addOutsideFile('not-ours.txt', 'keep me');
  const strayFolder = drive.addRootFolder('Someone else');
  return { outside, strayFolder };
}

function writeLocalState() {
  mkdirSync(paths.logsDir, { recursive: true });
  writeFileSync(paths.decisionsLog, '{"kind":"classify"}\n');
  writeFileSync(paths.outboxLog, '{"to":[]}\n');
  mkdirSync(paths.stateDir, { recursive: true });
  for (const f of ['appa.db', 'appa.db-wal', 'appa.db-shm', 'memory.json', 'poller.json', 'keep.txt']) {
    writeFileSync(join(paths.stateDir, f), 'x');
  }
}

describe('reset', () => {
  it('trashes the whole tree, ensures subfolders and uploads seeds 01–10 to the root', async () => {
    const { outside, strayFolder } = await dirtyDrive();
    const res = await run();

    expect(SEEDS).toHaveLength(10);
    expect(drive.snapshot()).toEqual({ root: SEEDS, legal: [], accounting: [], 'high-risk': [] });
    expect(res.trashed).toBe(5);
    expect(res.uploaded).toEqual(SEEDS);
    // Uploaded content is the seed file content.
    const root = await drive.listRoot();
    const nda = root.find((f) => f.name === SEEDS[0])!;
    expect((await drive.read(nda.id)).content).toBe(readFileSync(join(SEED_DIR, SEEDS[0]!), 'utf8'));
    // Nothing outside the tree was touched.
    expect(drive.outsideTreeIds()).toEqual([]);
    expect(drive.askedIds()).not.toContain(outside);
    expect(drive.askedIds()).not.toContain(strayFolder);
    expect(drive.items.get(outside)!.trashed).toBe(false);
    expect(drive.items.get(strayFolder)!.trashed).toBe(false);
  });

  it('creates missing subfolders on an empty root', async () => {
    await run();
    expect(drive.snapshot()).toEqual({ root: SEEDS, legal: [], accounting: [], 'high-risk': [] });
    expect(await drive.list('legal')).toEqual([]);
  });

  it('archives logs/ to runs/<stamp>/ and leaves empty decision and outbox logs', async () => {
    writeLocalState();
    const res = await run();
    expect(res.archivedTo).toBe(join(paths.runsDir, '2026-10-19T12-00-00-000Z'));
    expect(readFileSync(join(res.archivedTo!, 'decisions.jsonl'), 'utf8')).toBe('{"kind":"classify"}\n');
    expect(readFileSync(join(res.archivedTo!, 'outbox.jsonl'), 'utf8')).toBe('{"to":[]}\n');
    expect(readFileSync(paths.decisionsLog, 'utf8')).toBe('');
    expect(readFileSync(paths.outboxLog, 'utf8')).toBe('');
  });

  it('deletes state/appa.db*, memory.json and poller.json, and nothing else', async () => {
    writeLocalState();
    await run();
    expect(readdirSync(paths.stateDir)).toEqual(['keep.txt']);
  });

  it('gives the same state when run twice in a row', async () => {
    await dirtyDrive();
    writeLocalState();
    await run();
    const first = { drive: drive.snapshot(), logs: readdirSync(paths.logsDir).sort(), state: readdirSync(paths.stateDir).sort() };
    const second = await run();
    expect(drive.snapshot()).toEqual(first.drive);
    expect(readdirSync(paths.logsDir).sort()).toEqual(first.logs);
    expect(readdirSync(paths.stateDir).sort()).toEqual(first.state);
    expect(second.trashed).toBe(10);
    // Empty logs are not archived again.
    expect(second.archivedTo).toBeUndefined();
    expect(readdirSync(paths.runsDir)).toHaveLength(1);
    expect(drive.outsideTreeIds()).toEqual([]);
  });

  it('refuses while the sidecar answers /health, touching nothing', async () => {
    writeLocalState();
    const fetchSpy = vi.fn(up);
    await expect(reset({ drive, paths, sidecarUrl: 'http://127.0.0.1:8790', fetchImpl: fetchSpy, now })).rejects.toThrow(
      ResetRefusedError,
    );
    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:8790/health', expect.anything());
    expect(drive.items.size).toBe(0);
    expect(drive.calls).toEqual([]);
    expect(readFileSync(paths.decisionsLog, 'utf8')).not.toBe('');
    expect(existsSync(join(paths.stateDir, 'appa.db'))).toBe(true);
    expect(existsSync(paths.runsDir)).toBe(false);
  });

  it('refuses even when /health answers non-200', async () => {
    const fetchImpl: typeof fetch = async () => new Response('down', { status: 503 });
    await expect(reset({ drive, paths, sidecarUrl: 'http://127.0.0.1:8790', fetchImpl, now })).rejects.toThrow(/Stop `npm start`/);
  });

  it('checks the configured port on loopback', () => {
    expect(sidecarUrlFor({ appaPort: 8790 })).toBe('http://127.0.0.1:8790');
  });
});

describe('drop', () => {
  it('uploads seed/new/11-* to the root', async () => {
    await run();
    const out = await drop({ drive, paths });
    expect(out.map((f) => [f.name, f.folder])).toEqual([[NEW_SEED, 'root']]);
    expect(drive.snapshot().root).toEqual([...SEEDS, NEW_SEED].sort());
    expect(drive.outsideTreeIds()).toEqual([]);
  });
});

describe('CLIs', () => {
  function cliConfig(env: Record<string, string> = { GDRIVE_ROOT_FOLDER_ID: 'fake-root' }) {
    // A temp repo root with a copy of the seeds, synthetic env, no real .env.
    cpSync(SEED_DIR, join(tmp, 'clearance', 'seed'), { recursive: true });
    return loadConfig({ repoRoot: tmp, env });
  }
  const quiet = () => {};

  it('reset and drop run end to end with an injected Drive factory', async () => {
    const config = cliConfig();
    expect(await resetMain({ config, createDrive: async () => drive, fetchImpl: down, log: quiet })).toBe(0);
    expect(drive.snapshot().root).toEqual(SEEDS);
    expect(await dropMain({ config, createDrive: async () => drive, log: quiet })).toBe(0);
    expect(drive.snapshot().root).toContain(NEW_SEED);
    expect(readFileSync(config.paths.decisionsLog, 'utf8')).toBe('');
  });

  it('exit 1 with a clear message when GDRIVE_ROOT_FOLDER_ID is unset', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = cliConfig({});
    expect(await resetMain({ config, createDrive: async () => drive, fetchImpl: down, log: quiet })).toBe(1);
    expect(await dropMain({ config, createDrive: async () => drive, log: quiet })).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/GDRIVE_ROOT_FOLDER_ID is not set/));
    expect(drive.items.size).toBe(0);
    err.mockRestore();
  });

  it('exit 1 while the sidecar is up', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resetMain({ config: cliConfig(), createDrive: async () => drive, fetchImpl: up, log: quiet })).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/Refusing to reset/));
    err.mockRestore();
  });

  it('the default factory is the live client and refuses without credentials (no network, temp root)', async () => {
    // The temp repo root has no secrets/, so the factory fails before any Drive call.
    await expect(liveDriveFactory(cliConfig())).rejects.toThrow(ConfigError);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resetMain({ config: cliConfig(), fetchImpl: down, log: quiet })).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/not found|token/i));
    err.mockRestore();
  });
});
