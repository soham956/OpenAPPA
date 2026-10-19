import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, type PollerLike, type StartDeps } from '../src/cli/start';
import { ConfigError, loadConfig } from '../src/config';
import { FakeDriveClient } from '../src/drive/fake';
import type { Sidecar } from '../src/sidecar/runtime';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clearance-start-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const cfgWith = (env: Record<string, string>) => loadConfig({ repoRoot: root, env });

function harness(over: Partial<StartDeps> = {}, env: Record<string, string> = { GDRIVE_ROOT_FOLDER_ID: 'root' }) {
  const events: string[] = [];
  const out: string[] = [];
  const errs: string[] = [];
  const signals = new EventEmitter();
  let alive = true;
  const sidecar: Sidecar = {
    url: 'http://127.0.0.1:8790',
    pid: 1,
    running: () => alive,
    stop: async () => {
      events.push('sidecar.stop');
      alive = false;
    },
  };
  const drive = new FakeDriveClient();
  const ensure = vi.spyOn(drive, 'ensureSubfolders').mockImplementation(async () => {
    events.push('ensureSubfolders');
    return { legal: 'l', accounting: 'a', 'high-risk': 'h' };
  });
  const poller: PollerLike = {
    start: () => events.push('poller.start'),
    stop: async () => {
      events.push('poller.stop');
    },
  };
  const deps: StartDeps = {
    config: cfgWith(env),
    startSidecar: async () => {
      events.push('sidecar.start');
      return sidecar;
    },
    createDrive: async () => drive,
    createClassifier: () => async () => ({ label: 'Legal', rule: 'jev' }),
    createLog: () => ({ writeClassify: (l) => ({ kind: 'classify', ...l }) as never }),
    createPoller: () => poller,
    signals,
    watchMs: 5,
    log: (m) => out.push(m),
    err: (m) => errs.push(m),
    ...over,
  };
  return { deps, events, out, errs, signals, ensure, kill: () => (alive = false) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('npm start', () => {
  it('refuses without GDRIVE_ROOT_FOLDER_ID and starts nothing', async () => {
    const h = harness({}, {});
    expect(await main(h.deps)).toBe(1);
    expect(h.errs.join('\n')).toMatch(/GDRIVE_ROOT_FOLDER_ID/);
    expect(h.events).toEqual([]);
  });

  it('prints the ConfigError from the drive factory and exits 1 without a sidecar', async () => {
    const h = harness({
      createDrive: async () => {
        throw new ConfigError('no cached token; run npm run drive:check');
      },
    });
    expect(await main(h.deps)).toBe(1);
    expect(h.errs.join('\n')).toMatch(/npm run drive:check/);
    expect(h.events).toEqual([]);
  });

  it('exits 1 when the sidecar will not start', async () => {
    const h = harness({
      startSidecar: async () => {
        throw new Error('no /health');
      },
    });
    expect(await main(h.deps)).toBe(1);
    expect(h.errs.join('\n')).toMatch(/no \/health/);
    expect(h.events).toEqual([]);
  });

  it('starts sidecar, then subfolders, then the poller; SIGINT stops poller then sidecar and exits 0', async () => {
    const h = harness();
    const done = main(h.deps);
    await tick();
    expect(h.events).toEqual(['sidecar.start', 'ensureSubfolders', 'poller.start']);
    expect(h.out.join('\n')).toMatch(/http:\/\/127\.0\.0\.1:8790/);
    expect(h.out.join('\n')).toMatch(/polling every 10 s/);
    h.signals.emit('SIGINT');
    expect(await done).toBe(0);
    expect(h.events.slice(3)).toEqual(['poller.stop', 'sidecar.stop']);
  });

  it('SIGTERM also shuts down cleanly, once', async () => {
    const h = harness();
    const done = main(h.deps);
    await tick();
    h.signals.emit('SIGTERM');
    expect(await done).toBe(0);
    expect(h.events.filter((e) => e === 'sidecar.stop')).toHaveLength(1);
  });

  it('stops the poller and exits 1 when the sidecar dies', async () => {
    const h = harness();
    const done = main(h.deps);
    await tick();
    h.kill();
    expect(await done).toBe(1);
    expect(h.events).toContain('poller.stop');
    expect(h.errs.join('\n')).toMatch(/sidecar exited/);
  });

  it('prints each moved file', async () => {
    let writer: Parameters<NonNullable<StartDeps['createPoller']>>[0]['log'] | undefined;
    const h = harness({
      createPoller: (o) => {
        writer = o.log;
        return { start: () => undefined, stop: async () => undefined };
      },
    });
    const done = main(h.deps);
    await tick();
    writer!.writeClassify({ file: '05-invoice.txt', label: 'Accounting', rule: 'jev', moved: 'Accounting' });
    expect(h.out.join('\n')).toMatch(/moved 05-invoice\.txt -> Accounting/);
    h.signals.emit('SIGINT');
    await done;
  });

  it('shuts the sidecar down if startup fails after it started', async () => {
    const h = harness();
    h.ensure.mockRejectedValueOnce(new Error('drive down'));
    expect(await main(h.deps)).toBe(1);
    expect(h.events).toContain('sidecar.stop');
    expect(h.events).not.toContain('poller.start');
  });
});
