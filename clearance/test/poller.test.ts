import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Classification, ClassifyInput } from '../src/classifier/types';
import { FakeDriveClient } from '../src/drive/fake';
import { createDecisionLog, type DecisionLog } from '../src/log/decision-log';
import { createPoller, type ClassifyFn } from '../src/poller/poller';

// The ten step-1 seed files, with content that the stub classifier keys on.
const SEED: [string, string][] = [
  ['01-nda-meridian-labs.txt', 'SPECIMEN legal nda'],
  ['02-msa-northwind.txt', 'SPECIMEN legal msa'],
  ['03-lease-amendment.txt', 'SPECIMEN legal lease'],
  ['04-board-resolution.txt', 'SPECIMEN legal resolution'],
  ['05-invoice-0193.txt', 'SPECIMEN accounting invoice'],
  ['06-expense-report-q3.txt', 'SPECIMEN accounting expenses'],
  ['07-trial-balance.txt', 'SPECIMEN accounting ledger'],
  ['08-employment-contract-r-okafor.txt', 'SPECIMEN SPC-1234-5678 contract'],
  ['09-payroll-export.txt', 'SPECIMEN SPC-8765-4321 payroll'],
  ['10-settlement-payment-schedule.txt', 'SPECIMEN mixed settlement'],
];

/** Stub classifier: decides from content only, like the real one. */
const stubClassify: ClassifyFn = async ({ content }: ClassifyInput): Promise<Classification> => {
  if (/SPC-\d{4}-\d{4}/.test(content)) return { label: 'High Risk', rule: 'specimen-id' };
  if (content.includes('mixed'))
    return { label: 'High Risk', rule: 'low-confidence', jev: 'Legal', confidence: 0.58, source: 'fixture' };
  if (content.includes('legal')) return { label: 'Legal', rule: 'jev', jev: 'Legal', confidence: 0.95, source: 'fixture' };
  return { label: 'Accounting', rule: 'jev', jev: 'Accounting', confidence: 0.93, source: 'fixture' };
};

let dir: string;
let statePath: string;
let drive: FakeDriveClient;
let log: DecisionLog;

function poller(classify: ClassifyFn = stubClassify, extra: { intervalMs?: number } = {}) {
  return createPoller({ drive, classify, log, statePath, intervalMs: extra.intervalMs ?? 1000, onError: () => {} });
}

async function seed(): Promise<void> {
  await drive.ensureSubfolders();
  for (const [name, content] of SEED) await drive.upload(name, content);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'poller-'));
  statePath = join(dir, 'state', 'poller.json');
  drive = new FakeDriveClient();
  log = createDecisionLog({ path: join(dir, 'logs', 'decisions.jsonl'), now: () => new Date('2026-10-19T12:00:00Z') });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('Poller.tick', () => {
  it('moves and logs all 10 root files in one tick', async () => {
    await seed();
    const result = await poller().tick();

    expect(result.moved).toHaveLength(10);
    expect(result.failed).toEqual([]);
    const snap = drive.snapshot();
    expect(snap.root).toEqual([]);
    expect(snap.legal).toEqual(SEED.slice(0, 4).map(([n]) => n));
    expect(snap.accounting).toEqual(SEED.slice(4, 7).map(([n]) => n));
    expect(snap['high-risk']).toEqual(SEED.slice(7).map(([n]) => n));

    const lines = log.readClassify();
    expect(lines).toHaveLength(10);
    const byFile = Object.fromEntries(lines.map((l) => [l.file, l]));
    const { ts: _t8, fileId: _f8, ...l08 } = byFile['08-employment-contract-r-okafor.txt']!;
    expect(l08).toEqual({
      kind: 'classify',
      file: '08-employment-contract-r-okafor.txt',
      label: 'High Risk',
      rule: 'specimen-id',
      moved: 'High Risk',
    });
    const { ts: _t10, fileId: _f10, ...l10 } = byFile['10-settlement-payment-schedule.txt']!;
    expect(l10).toEqual({
      kind: 'classify',
      file: '10-settlement-payment-schedule.txt',
      label: 'High Risk',
      rule: 'low-confidence',
      jev: 'Legal',
      confidence: 0.58,
      source: 'fixture',
      moved: 'High Risk',
    });
    for (const l of lines) expect(l.moved).toBe(l.label);
  });

  it('classifies from content only: a misleading name does not change the label', async () => {
    await drive.upload('SPC-0000-0000-legal.txt', 'SPECIMEN accounting invoice');
    const seen: ClassifyInput[] = [];
    await poller(async (input) => (seen.push(input), stubClassify(input))).tick();
    expect(drive.snapshot().accounting).toEqual(['SPC-0000-0000-legal.txt']);
    expect(seen).toEqual([{ content: 'SPECIMEN accounting invoice', file: 'SPC-0000-0000-legal.txt' }]);
  });

  it('moves a file added later on the next tick without a restart', async () => {
    await seed();
    const p = poller();
    await p.tick();
    await drive.upload('11-vendor-invoice-0207.txt', 'SPECIMEN accounting invoice');

    const second = await p.tick();
    expect(second.moved.map((m) => m.line.file)).toEqual(['11-vendor-invoice-0207.txt']);
    expect(drive.snapshot().accounting).toContain('11-vendor-invoice-0207.txt');
    expect(drive.snapshot().root).toEqual([]);
    expect(log.readClassify()).toHaveLength(11);
  });

  it('never touches files in the subfolders', async () => {
    await drive.ensureSubfolders();
    const inLegal = (await drive.upload('already-legal.txt', 'SPECIMEN accounting', 'legal')).id;
    const inHigh = (await drive.upload('already-high.txt', 'SPECIMEN legal', 'high-risk')).id;
    drive.addRootFolder('Unrelated folder');
    await drive.upload('root-file.txt', 'SPECIMEN legal');

    await poller().tick();

    expect(drive.askedIds()).not.toContain(inLegal);
    expect(drive.askedIds()).not.toContain(inHigh);
    expect(drive.outsideTreeIds()).toEqual([]);
    const snap = drive.snapshot();
    expect(snap.legal).toEqual(['already-legal.txt', 'root-file.txt']);
    expect(snap['high-risk']).toEqual(['already-high.txt']);
    expect(log.readClassify().map((l) => l.file)).toEqual(['root-file.txt']);
  });
});

describe('seen ids', () => {
  it('persist to the state file so a restart never logs a file twice', async () => {
    await seed();
    const first = poller();
    await first.tick();
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { seen: string[] };
    expect(state.seen).toHaveLength(10);

    // Someone drags a file back into the root; a restarted poller still skips it.
    const back = first.seenIds()[0]!;
    await drive.move(back, 'root');
    const restarted = poller();
    expect(restarted.seenIds()).toEqual(first.seenIds());
    const result = await restarted.tick();
    expect(result.moved).toEqual([]);
    expect(log.readClassify()).toHaveLength(10);
  });
});

describe('failures', () => {
  it('leaves a file whose classify fails in the root and retries it next tick', async () => {
    await seed();
    let failOnce = true;
    const flaky: ClassifyFn = async (input) => {
      if (input.content.includes('SPC-1234') && failOnce) {
        failOnce = false;
        throw new Error('jev unavailable');
      }
      return stubClassify(input);
    };
    const p = poller(flaky);

    const first = await p.tick();
    expect(first.moved).toHaveLength(9);
    expect(first.failed.map((f) => f.file)).toEqual(['08-employment-contract-r-okafor.txt']);
    expect(drive.snapshot().root).toEqual(['08-employment-contract-r-okafor.txt']);
    expect(log.readClassify()).toHaveLength(9);
    expect(p.seenIds()).toHaveLength(9);

    const second = await p.tick();
    expect(second.moved.map((m) => m.line.file)).toEqual(['08-employment-contract-r-okafor.txt']);
    expect(drive.snapshot().root).toEqual([]);
    expect(log.readClassify()).toHaveLength(10);
  });

  it('leaves a file whose move fails in the root, unlogged and unseen, and retries it', async () => {
    const id = (await drive.upload('05-invoice-0193.txt', 'SPECIMEN accounting invoice')).id;
    const realMove = drive.move.bind(drive);
    const spy = vi.spyOn(drive, 'move').mockRejectedValueOnce(new Error('drive 503'));
    const p = poller();

    const first = await p.tick();
    expect(first.failed).toHaveLength(1);
    expect(drive.snapshot().root).toEqual(['05-invoice-0193.txt']);
    expect(log.readClassify()).toEqual([]);
    expect(p.seenIds()).toEqual([]);

    // A restart in between still retries it (it was never persisted as seen).
    spy.mockImplementation(realMove);
    const second = await poller().tick();
    expect(second.moved.map((m) => m.fileId)).toEqual([id]);
    expect(drive.snapshot().accounting).toEqual(['05-invoice-0193.txt']);
    expect(log.readClassify()).toHaveLength(1);
  });
});

describe('loop', () => {
  it('ticks every intervalMs after start() and stops cleanly', async () => {
    vi.useFakeTimers();
    await seed();
    const p = poller(stubClassify, { intervalMs: 10_000 });
    const tick = vi.spyOn(p, 'tick');

    p.start();
    p.start(); // idempotent
    expect(p.isRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(drive.snapshot().root).toEqual([]);

    await drive.upload('11-vendor-invoice-0207.txt', 'SPECIMEN accounting invoice');
    await vi.advanceTimersByTimeAsync(9_999);
    expect(drive.snapshot().root).toEqual(['11-vendor-invoice-0207.txt']);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(drive.snapshot().accounting).toContain('11-vendor-invoice-0207.txt');

    await p.stop();
    expect(p.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps running when listing the root fails', async () => {
    vi.useFakeTimers();
    await drive.upload('01-nda-meridian-labs.txt', 'SPECIMEN legal nda');
    vi.spyOn(drive, 'listRoot').mockRejectedValueOnce(new Error('network'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p = poller(stubClassify, { intervalMs: 1000 });

    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(drive.snapshot().root).toEqual(['01-nda-meridian-labs.txt']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(drive.snapshot().legal).toEqual(['01-nda-meridian-labs.txt']);
    await p.stop();
    err.mockRestore();
  });
});
