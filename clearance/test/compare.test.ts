import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExpected, compareRuns, loadExpected, runCompareCli } from '../src/log/compare';
import { DecisionLog } from '../src/log/decision-log';
import type { ClassifyLine, EnforceLine, OutboxLine } from '../src/log/schema';
import { appendJsonl } from '../src/util/jsonl';

const EXPECTED_FILE = fileURLToPath(new URL('../expected-decisions.json', import.meta.url));
const expected = loadExpected(EXPECTED_FILE);

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'compare-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface RunOpts {
  /** Distinguishes timestamps and ids between runs. */
  tag: string;
  reverseClassify?: boolean;
  tweakEnforce?: (lines: EnforceLine[]) => EnforceLine[];
  tweakOutbox?: (lines: OutboxLine[]) => OutboxLine[];
  nested?: boolean;
}

/** Write a run folder that conforms to expected-decisions.json. */
function makeRun(name: string, o: RunOpts): string {
  const dir = join(root, name);
  const logs = o.nested ? join(dir, 'logs') : dir;
  mkdirSync(logs, { recursive: true });
  const log = new DecisionLog({ path: join(logs, 'decisions.jsonl'), now: () => new Date(`2026-10-19T12:00:0${o.tag.length}Z`) });
  let classify = [...(expected.classify as unknown as ClassifyLine[])];
  if (o.reverseClassify) classify.reverse();
  classify.forEach((l, i) => log.write({ ...l, fileId: `${o.tag}-file-${i}` }));
  let enforce = expected.enforce as unknown as EnforceLine[];
  if (o.tweakEnforce) enforce = o.tweakEnforce(enforce);
  enforce.forEach((l, i) => log.write(l.step === 'read' ? { ...l, offerId: `${o.tag}-offer-${i}` } : l));
  let outbox = expected.outbox as unknown as OutboxLine[];
  if (o.tweakOutbox) outbox = o.tweakOutbox(outbox);
  for (const l of outbox) appendJsonl(join(logs, 'outbox.jsonl'), l);
  return dir;
}

describe('expected-decisions.json', () => {
  it('holds 11 classify lines, 4 read allows, the six enforce steps and one outbox line', () => {
    expect(expected.classify).toHaveLength(11);
    const reads = expected.enforce.filter((l) => l.step === 'read');
    expect(reads).toHaveLength(4);
    expect(reads.every((l) => l.decision === 'allow')).toBe(true);
    expect(expected.enforce.filter((l) => l.step !== 'read').map((l) => l.step)).toEqual(['2a', '2b', '2c-save', '2c-load', '2c', '2d']);
    expect(expected.outbox).toHaveLength(1);
  });

  it('uses the exact reason strings from the demo script', () => {
    const demo = readFileSync(fileURLToPath(new URL('../../docs/demo-script.md', import.meta.url)), 'utf8');
    const reasons = expected.enforce.filter((l) => l.decision === 'deny').map((l) => l.reason as string);
    expect(reasons).toHaveLength(3);
    for (const r of reasons) expect(demo).toContain(r);
  });

  it('labels the seed files as the demo script table says', () => {
    const byFile = Object.fromEntries(expected.classify.map((l) => [l.file as string, l.label]));
    expect(byFile['01-mutual-nda-kestrel-orbit.txt']).toBe('Legal');
    expect(byFile['05-invoice-0193.txt']).toBe('Accounting');
    expect(byFile['08-employment-contract-r-okafor.txt']).toBe('High Risk');
    expect(byFile['10-settlement-payment-schedule.txt']).toBe('High Risk');
    expect(byFile['11-vendor-invoice-0207.txt']).toBe('Accounting');
  });
});

describe('compareRuns', () => {
  it('is identical despite different ts, Drive ids, offer ids and classify order', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'bb', reverseClassify: true });
    expect(compareRuns(a, b)).toBeUndefined();
  });

  it('finds runs in a logs/ subfolder', () => {
    const a = makeRun('a', { tag: 'a', nested: true });
    const b = makeRun('b', { tag: 'b' });
    expect(compareRuns(a, b)).toBeUndefined();
  });

  it('reports a changed decision', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', {
      tag: 'b',
      tweakEnforce: (ls) => ls.map((l) => (l.step === '2d' ? { ...l, decision: 'deny' as const } : l)),
    });
    const d = compareRuns(a, b);
    expect(d?.where).toBe('enforce #10');
    expect(d?.a).toContain('"allow"');
    expect(d?.b).toContain('"deny"');
  });

  it('reports a missing enforce line', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'b', tweakEnforce: (ls) => ls.slice(0, -1) });
    const d = compareRuns(a, b);
    expect(d?.where).toBe('enforce #10');
    expect(d?.b).toBe('(missing)');
  });

  it('reports an outbox difference', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'b', tweakOutbox: (ls) => ls.map((l) => ({ ...l, subject: 'other' })) });
    expect(compareRuns(a, b)?.where).toBe('outbox #1');
  });

  it('treats a changed classify rule as a difference', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'b' });
    const lines = readFileSync(join(b, 'decisions.jsonl'), 'utf8').replace('"rule":"specimen-id"', '"rule":"jev"');
    writeFileSync(join(b, 'decisions.jsonl'), lines);
    expect(compareRuns(a, b)?.where).toMatch(/^classify #/);
  });
});

describe('checkExpected', () => {
  it('passes a conforming run', () => {
    expect(checkExpected(makeRun('a', { tag: 'a' }), EXPECTED_FILE)).toBeUndefined();
  });

  it('fails when the 2c reason text is wrong', () => {
    const run = makeRun('a', {
      tag: 'a',
      tweakEnforce: (ls) => ls.map((l) => (l.step === '2c' ? { ...l, reason: 'Blocked: something else' } : l)),
    });
    expect(checkExpected(run, EXPECTED_FILE)?.where).toBe('enforce #9');
  });

  it('fails when a classify line is missing', () => {
    const run = makeRun('a', { tag: 'a' });
    const kept = readFileSync(join(run, 'decisions.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
    writeFileSync(join(run, 'decisions.jsonl'), kept.slice(1).join('\n') + '\n');
    expect(checkExpected(run, EXPECTED_FILE)?.where).toMatch(/^classify #/);
  });

  it('fails when the outbox is empty', () => {
    const run = makeRun('a', { tag: 'a', tweakOutbox: () => [] });
    expect(checkExpected(run, EXPECTED_FILE)?.where).toBe('outbox #1');
  });
});

describe('runCompareCli', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it('prints identical and exits 0', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'b' });
    const c = capture();
    expect(runCompareCli([a, b], c.io)).toBe(0);
    expect(c.out).toEqual(['identical']);
  });

  it('prints the first difference and exits 1', () => {
    const a = makeRun('a', { tag: 'a' });
    const b = makeRun('b', { tag: 'b', tweakOutbox: () => [] });
    const c = capture();
    expect(runCompareCli([a, b], c.io)).toBe(1);
    expect(c.out.join('\n')).toContain('outbox #1');
  });

  it('checks --expected against the default file', () => {
    const a = makeRun('a', { tag: 'a' });
    const c = capture();
    expect(runCompareCli(['--expected', a], c.io)).toBe(0);
    expect(c.out).toEqual(['matches expected']);
  });

  it('exits 1 when --expected does not match', () => {
    const a = makeRun('a', { tag: 'a', tweakOutbox: () => [] });
    expect(runCompareCli(['--expected', a], capture().io)).toBe(1);
  });

  it('exits 2 on bad usage or a missing run folder', () => {
    expect(runCompareCli([], capture().io)).toBe(2);
    expect(runCompareCli(['--expected'], capture().io)).toBe(2);
    const c = capture();
    expect(runCompareCli([join(root, 'nope'), join(root, 'nope2')], c.io)).toBe(2);
    expect(c.err.join('')).toContain('not found');
  });
});
