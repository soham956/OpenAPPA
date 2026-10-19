import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionLog, DecisionLogFormatError } from '../src/log/decision-log';
import type { ClassifyLine, EnforceLine } from '../src/log/schema';

// Example lines from docs/demo-script.md (ellipses expanded to real values).
const CLASSIFY_08: Omit<ClassifyLine, 'kind' | 'ts'> = {
  file: '08-employment-contract-r-okafor.txt',
  label: 'High Risk',
  rule: 'specimen-id',
  moved: 'High Risk',
};
const CLASSIFY_10: Omit<ClassifyLine, 'kind' | 'ts'> = {
  file: '10-settlement-payment-schedule.txt',
  label: 'High Risk',
  rule: 'low-confidence',
  jev: 'Legal',
  confidence: 0.58,
  source: 'fixture',
};
const ENFORCE_2A: Omit<EnforceLine, 'kind' | 'ts'> = {
  step: '2a',
  session: 'agent-1',
  tool: 'send',
  decision: 'deny',
  reason:
    'Blocked: Legal content may only go to legal@hashirai-poc.test. counsel@outside-firm.test is outside that list.',
};

const FIXED = new Date('2026-10-19T12:00:00.000Z');
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-log-'));
  path = join(dir, 'nested', 'decisions.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = () => createDecisionLog({ path, now: () => FIXED });

describe('decision log', () => {
  it('reads as empty when the file does not exist', () => {
    expect(make().readAll()).toEqual([]);
  });

  it('writes one line per call with ts and creates parent dirs', () => {
    const log = make();
    log.writeClassify(CLASSIFY_08);
    log.writeEnforce(ENFORCE_2A);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(JSON.parse(l).ts).toBe(FIXED.toISOString());
  });

  it('serialises the demo-script classify line 08 with exact key order', () => {
    make().writeClassify(CLASSIFY_08);
    expect(readFileSync(path, 'utf8').trim()).toBe(
      '{"kind":"classify","file":"08-employment-contract-r-okafor.txt","label":"High Risk","rule":"specimen-id","moved":"High Risk","ts":"2026-10-19T12:00:00.000Z"}',
    );
  });

  it('serialises the demo-script classify line 10 with exact key order', () => {
    make().writeClassify(CLASSIFY_10);
    expect(readFileSync(path, 'utf8').trim()).toBe(
      '{"kind":"classify","file":"10-settlement-payment-schedule.txt","label":"High Risk","rule":"low-confidence","jev":"Legal","confidence":0.58,"source":"fixture","ts":"2026-10-19T12:00:00.000Z"}',
    );
  });

  it('serialises the demo-script enforce line with exact key order', () => {
    make().writeEnforce(ENFORCE_2A);
    expect(readFileSync(path, 'utf8').trim()).toBe(
      `{"kind":"enforce","step":"2a","session":"agent-1","tool":"send","decision":"deny","reason":${JSON.stringify(ENFORCE_2A.reason)},"ts":"2026-10-19T12:00:00.000Z"}`,
    );
  });

  it('reorders keys supplied out of order', () => {
    make().write({
      ts: 'ignored',
      source: 'fixture',
      confidence: 0.58,
      jev: 'Legal',
      rule: 'low-confidence',
      label: 'High Risk',
      file: 'x.txt',
      kind: 'classify',
    });
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).toEqual([
      'kind', 'file', 'label', 'rule', 'jev', 'confidence', 'source', 'ts',
    ]);
  });

  it('round-trips every demo-script example line, typed, in order', () => {
    const log = make();
    const a = log.writeClassify(CLASSIFY_08);
    const b = log.writeClassify(CLASSIFY_10);
    const c = log.writeEnforce(ENFORCE_2A);
    expect(log.readAll()).toEqual([a, b, c]);
    expect(log.readClassify()).toEqual([a, b]);
    expect(log.readEnforce()).toEqual([c]);
    expect(a).toMatchObject({ kind: 'classify', ...CLASSIFY_08, ts: FIXED.toISOString() });
    expect(c).toMatchObject({ kind: 'enforce', ...ENFORCE_2A });
  });

  it('round-trips enforce lines carrying to, file, scope and offerId', () => {
    const log = make();
    const rows = [
      log.writeEnforce({ step: 'read', session: 'agent-1', tool: 'drive_read', file: '01-mutual-nda-kestrel-orbit.txt', decision: 'allow' }),
      log.writeEnforce({ step: '2c-save', session: 'agent-1', tool: 'memory_save', scope: 'legal-handoff', decision: 'allow' }),
      log.writeEnforce({ step: '2d', session: 'agent-1', tool: 'send', to: ['legal@hashirai-poc.test'], decision: 'allow', offerId: 'offer-1' }),
      log.writeEnforce({ step: '2b', session: 'agent-1', tool: 'send', to: ['counsel@outside-firm.test'], decision: 'error', reason: 'timeout' }),
    ];
    expect(log.readEnforce()).toEqual(rows);
  });

  it('appends across instances of the same path', () => {
    make().writeClassify(CLASSIFY_08);
    make().writeEnforce(ENFORCE_2A);
    expect(make().readAll()).toHaveLength(2);
  });

  it('rejects an invalid line without writing it', () => {
    const bad = { kind: 'classify', file: 'x', label: 'Nope', rule: 'jev' } as unknown as ClassifyLine;
    expect(() => make().write(bad)).toThrow(TypeError);
    expect(make().readAll()).toEqual([]);
  });

  it('throws a typed error when the file holds a non-decision line', () => {
    writeFileSync(path.replace('nested/', ''), '{"to":["a@b.test"]}\n');
    const log = createDecisionLog({ path: path.replace('nested/', '') });
    expect(() => log.readAll()).toThrow(DecisionLogFormatError);
  });
});
