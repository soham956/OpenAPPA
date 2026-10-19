import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { classify, createClassifier, decideFromAnswer } from '../src/classifier/decide';
import { FixtureError, FixtureStore, MissingJevError, parseFixture, serializeFixture, sha256 } from '../src/classifier/fixture-store';
import { findSpecimenId, hasSpecimenId } from '../src/classifier/specimen';
import type { Jev, JevAnswer } from '../src/classifier/types';
import { isClassifyLine } from '../src/log/schema';

const here = dirname(fileURLToPath(import.meta.url));
const seedDir = join(here, '..', 'seed');
const SAMPLE = join(here, 'fixtures', 'classifications.sample.json');

const SEEDS = [
  '01-mutual-nda-kestrel-orbit.txt',
  '02-master-services-agreement.txt',
  '03-cease-and-desist-letter.txt',
  '04-board-resolution-oct.txt',
  '05-invoice-0193.txt',
  '06-q3-expense-report.txt',
  '07-trial-balance-sept.txt',
  '08-employment-contract-r-okafor.txt',
  '09-payslip-sept-m-lindqvist.txt',
  '10-settlement-payment-schedule.txt',
  'new/11-vendor-invoice-0207.txt',
];
const EXPECTED: Record<string, { label: string; rule: string }> = {
  '01-mutual-nda-kestrel-orbit.txt': { label: 'Legal', rule: 'jev' },
  '02-master-services-agreement.txt': { label: 'Legal', rule: 'jev' },
  '03-cease-and-desist-letter.txt': { label: 'Legal', rule: 'jev' },
  '04-board-resolution-oct.txt': { label: 'Legal', rule: 'jev' },
  '05-invoice-0193.txt': { label: 'Accounting', rule: 'jev' },
  '06-q3-expense-report.txt': { label: 'Accounting', rule: 'jev' },
  '07-trial-balance-sept.txt': { label: 'Accounting', rule: 'jev' },
  '08-employment-contract-r-okafor.txt': { label: 'High Risk', rule: 'specimen-id' },
  '09-payslip-sept-m-lindqvist.txt': { label: 'High Risk', rule: 'specimen-id' },
  '10-settlement-payment-schedule.txt': { label: 'High Risk', rule: 'low-confidence' },
  'new/11-vendor-invoice-0207.txt': { label: 'Accounting', rule: 'jev' },
};
const seed = (f: string) => readFileSync(join(seedDir, f), 'utf8');
const base = (f: string) => f.replace(/^new\//, '');

/** A fake Jev that records every argument it receives. */
function fakeJev(answer: JevAnswer = { label: 'Legal', confidence: 0.9 }) {
  return vi.fn<Jev>(async () => answer);
}

let dir: string;
let fixture: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clearance-classifier-'));
  fixture = join(dir, 'fixtures', 'classifications.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('specimen ID rule', () => {
  it('matches SPC-dddd-dddd only', () => {
    expect(findSpecimenId('Employee ID: SPC-4417-2290.')).toBe('SPC-4417-2290');
    expect(hasSpecimenId('SPC-441-2290')).toBe(false);
    expect(hasSpecimenId('Matter Ref: LM-2026-0417')).toBe(false);
  });

  it('fires for seeds 08 and 09 and no others', () => {
    const hits = SEEDS.filter((f) => hasSpecimenId(seed(f)));
    expect(hits).toEqual(['08-employment-contract-r-okafor.txt', '09-payslip-sept-m-lindqvist.txt']);
  });

  it('runs first and never calls Jev (08, 09 → High Risk, specimen-id)', async () => {
    const jev = fakeJev();
    const answers = new FixtureStore({ path: fixture, jev });
    for (const f of ['08-employment-contract-r-okafor.txt', '09-payslip-sept-m-lindqvist.txt']) {
      expect(await classify({ content: seed(f), file: f }, { answers, threshold: 0.7 })).toEqual({ label: 'High Risk', rule: 'specimen-id' });
    }
    expect(jev).not.toHaveBeenCalled();
    expect(existsSync(fixture)).toBe(false);
  });
});

describe('threshold decision', () => {
  it('below threshold → High Risk, low-confidence, keeping Jev label and confidence', () => {
    expect(decideFromAnswer({ label: 'Legal', confidence: 0.58, source: 'fixture' }, 0.7)).toEqual({
      label: 'High Risk',
      rule: 'low-confidence',
      jev: 'Legal',
      confidence: 0.58,
      source: 'fixture',
    });
  });

  it('at or above threshold → the Jev label, rule jev', () => {
    expect(decideFromAnswer({ label: 'Accounting', confidence: 0.7, source: 'live' }, 0.7)).toEqual({
      label: 'Accounting',
      rule: 'jev',
      jev: 'Accounting',
      confidence: 0.7,
      source: 'live',
    });
  });

  it('reads CONFIDENCE_THRESHOLD from env (default 0.70)', async () => {
    const answers = { answer: async () => ({ label: 'Legal' as const, confidence: 0.75, source: 'fixture' as const }) };
    const dflt = loadConfig({ repoRoot: dir, env: {} }).confidenceThreshold;
    const strict = loadConfig({ repoRoot: dir, env: { CONFIDENCE_THRESHOLD: '0.8' } }).confidenceThreshold;
    expect(dflt).toBe(0.7);
    expect((await classify({ content: 'x' }, { answers, threshold: dflt })).label).toBe('Legal');
    expect((await classify({ content: 'x' }, { answers, threshold: strict })).rule).toBe('low-confidence');
  });
});

describe('fixture store', () => {
  it('a hit → source fixture, Jev not called', async () => {
    copyFileSync(SAMPLE, join(dir, 'f.json'));
    const jev = fakeJev();
    const store = new FixtureStore({ path: join(dir, 'f.json'), jev });
    const content = seed('10-settlement-payment-schedule.txt');
    expect(await store.answer(content)).toEqual({ label: 'Legal', confidence: 0.58, source: 'fixture' });
    expect(jev).not.toHaveBeenCalled();
  });

  it('a miss calls the injected Jev, records the answer and → source live', async () => {
    const jev = fakeJev({ label: 'Accounting', confidence: 0.88 });
    const store = new FixtureStore({ path: fixture, jev });
    expect(await store.answer('invoice body', 'x.txt')).toEqual({ label: 'Accounting', confidence: 0.88, source: 'live' });
    expect(jev).toHaveBeenCalledTimes(1);
    const saved = parseFixture(readFileSync(fixture, 'utf8'));
    expect(saved).toEqual({ [sha256('invoice body')]: { label: 'Accounting', confidence: 0.88, note: 'x.txt' } });

    // A new store over the recorded file now hits without Jev.
    const replay = new FixtureStore({ path: fixture });
    expect(await replay.answer('invoice body')).toEqual({ label: 'Accounting', confidence: 0.88, source: 'fixture' });
  });

  it('a miss with no Jev (no key) fails with a clear error', async () => {
    const store = new FixtureStore({ path: fixture });
    await expect(store.answer('unseen', 'unseen.txt')).rejects.toThrow(MissingJevError);
    await expect(store.answer('unseen', 'unseen.txt')).rejects.toThrow(/No recorded classification for "unseen.txt".*TYPESAFE_API_KEY is not set/);
    expect(existsSync(fixture)).toBe(false);
  });

  it('live mode always calls Jev and re-records', async () => {
    const path = join(dir, 'f.json');
    copyFileSync(SAMPLE, path);
    const jev = fakeJev({ label: 'Legal', confidence: 0.61 });
    const store = new FixtureStore({ path, jev, mode: 'live' });
    const content = seed('10-settlement-payment-schedule.txt');
    expect(await store.answer(content)).toEqual({ label: 'Legal', confidence: 0.61, source: 'live' });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(parseFixture(readFileSync(path, 'utf8'))[sha256(content)]?.confidence).toBe(0.61);
    await expect(new FixtureStore({ path, mode: 'live' }).answer(content)).rejects.toThrow(/CLASSIFIER_MODE=live needs Jev/);
  });

  it('writes the file sorted by hash, file name only as a note', async () => {
    const answers: Record<string, JevAnswer> = { a: { label: 'Legal', confidence: 0.9 }, b: { label: 'Accounting', confidence: 0.8 }, c: { label: 'Legal', confidence: 0.75 } };
    const store = new FixtureStore({ path: fixture, jev: async (c) => answers[c]! });
    for (const c of ['c', 'a', 'b']) await store.answer(c, `${c}.txt`);
    const text = readFileSync(fixture, 'utf8');
    const keys = Object.keys(JSON.parse(text));
    expect(keys).toEqual([...keys].sort());
    expect(keys).toEqual(['a', 'b', 'c'].map(sha256).sort());
    expect(text).toBe(serializeFixture(parseFixture(text)));
    expect(JSON.parse(text)[sha256('a')]).toEqual({ label: 'Legal', confidence: 0.9, note: 'a.txt' });
  });

  it('rejects a malformed fixture or Jev answer', async () => {
    expect(() => parseFixture('{"abc":{"label":"Legal","confidence":0.9}}')).toThrow(FixtureError);
    expect(() => parseFixture(`{"${sha256('x')}":{"label":"High Risk","confidence":0.9}}`)).toThrow(FixtureError);
    expect(() => parseFixture(`{"${sha256('x')}":{"label":"Legal","confidence":1.5}}`)).toThrow(FixtureError);
    const store = new FixtureStore({ path: fixture, jev: async () => ({ label: 'Secret', confidence: 0.9 }) as unknown as JevAnswer });
    await expect(store.answer('x')).rejects.toThrow(FixtureError);
  });
});

describe('Jev never receives the file name', () => {
  it('passes the content only, as the single argument', async () => {
    const jev = fakeJev();
    const classifyDoc = createClassifier({ fixturePath: fixture, jev, mode: 'replay', threshold: 0.7 });
    const file = '02-master-services-agreement.txt';
    const content = seed(file);
    await classifyDoc({ content, file });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(jev.mock.calls[0]).toEqual([content]);
    for (const arg of jev.mock.calls[0]!) expect(JSON.stringify(arg)).not.toContain('master-services-agreement');
  });
});

describe('sample fixture over the seed files', () => {
  it('is sorted by hash and keyed by the seed contents', () => {
    const text = readFileSync(SAMPLE, 'utf8');
    expect(text).toBe(serializeFixture(parseFixture(text)));
    const entries = parseFixture(text);
    for (const [hash, e] of Object.entries(entries)) {
      const f = SEEDS.find((s) => base(s) === e.note);
      expect(f, e.note).toBeDefined();
      expect(sha256(seed(f!))).toBe(hash);
    }
  });

  it('replays all 11 demo files to the expected label and rule without Jev', async () => {
    const jev = fakeJev();
    const classifyDoc = createClassifier({ fixturePath: SAMPLE, jev, mode: 'replay', threshold: 0.7 });
    for (const f of SEEDS) {
      const c = await classifyDoc({ content: seed(f), file: base(f) });
      expect({ label: c.label, rule: c.rule }, f).toEqual(EXPECTED[f]);
      if (c.rule !== 'specimen-id') expect(c.source, f).toBe('fixture');
      expect(isClassifyLine({ kind: 'classify', file: base(f), ...c }), f).toBe(true);
    }
    expect(jev).not.toHaveBeenCalled();
  });

  it('produces the demo-script line for file 10', async () => {
    const classifyDoc = createClassifier({ fixturePath: SAMPLE, mode: 'replay', threshold: 0.7 });
    const file = '10-settlement-payment-schedule.txt';
    expect(await classifyDoc({ content: seed(file), file })).toEqual({
      label: 'High Risk',
      rule: 'low-confidence',
      jev: 'Legal',
      confidence: 0.58,
      source: 'fixture',
    });
  });
});
