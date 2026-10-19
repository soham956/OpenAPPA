import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLASSIFY_KEYS,
  ENFORCE_KEYS,
  isClassifyLine,
  isDecisionLine,
  isEnforceLine,
  isOutboxLine,
  orderKeys,
  type EnforceLine,
} from '../src/log/schema';
import { JsonlParseError, appendJsonl, parseJsonl, readJsonl, writeJsonl } from '../src/util/jsonl';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clearance-jsonl-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('jsonl', () => {
  it('appends one line per call, creating parent dirs', () => {
    const file = join(dir, 'logs', 'nested', 'a.jsonl');
    appendJsonl(file, { a: 1 });
    appendJsonl(file, { b: 'two' });
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}\n{"b":"two"}\n');
    expect(readJsonl(file)).toEqual([{ a: 1 }, { b: 'two' }]);
  });

  it('reads a missing file as empty', () => {
    expect(readJsonl(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('skips blank lines and reports bad lines with their number', () => {
    expect(parseJsonl('{"a":1}\n\n  \n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
    const file = join(dir, 'bad.jsonl');
    writeFileSync(file, '{"a":1}\n{oops\n');
    expect(() => readJsonl(file)).toThrow(JsonlParseError);
    expect(() => readJsonl(file)).toThrow(/bad\.jsonl:2:/);
  });

  it('writeJsonl replaces the file and preserves key order', () => {
    const file = join(dir, 'w.jsonl');
    writeJsonl(file, [{ z: 1, a: 2 }]);
    writeJsonl(file, [{ y: 1, b: 2 }, { c: 3 }]);
    expect(readFileSync(file, 'utf8')).toBe('{"y":1,"b":2}\n{"c":3}\n');
    writeJsonl(file, []);
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});

// The example lines from docs/demo-script.md, verbatim ("…" stays as is).
const demoClassify = [
  '{"kind":"classify","file":"08-employment-contract-r-okafor.txt","label":"High Risk","rule":"specimen-id","moved":"High Risk"}',
  '{"kind":"classify","file":"10-settlement-payment-schedule.txt","label":"High Risk","rule":"low-confidence","jev":"Legal","confidence":0.58,"source":"fixture"}',
];
const demoEnforce = '{"kind":"enforce","step":"2a","session":"agent-1","tool":"send","decision":"deny","reason":"Blocked: …"}';
const demoOutbox =
  '{"to":["legal@hashirai-poc.test"],"subject":"Legal documents for review","attachments":["01-…","02-…","03-…","04-…"],"session":"agent-1"}';

describe('schema', () => {
  it('accepts every demo-script example line and round-trips it byte for byte', () => {
    for (const line of demoClassify) {
      const v = JSON.parse(line);
      expect(isClassifyLine(v), line).toBe(true);
      expect(isDecisionLine(v)).toBe(true);
      expect(JSON.stringify(orderKeys(v, CLASSIFY_KEYS))).toBe(line);
    }
    const e = JSON.parse(demoEnforce);
    expect(isEnforceLine(e)).toBe(true);
    expect(JSON.stringify(orderKeys(e, ENFORCE_KEYS))).toBe(demoEnforce);
    expect(isOutboxLine(JSON.parse(demoOutbox))).toBe(true);
  });

  it('accepts decision "error" on an enforce line', () => {
    const line: EnforceLine = { kind: 'enforce', step: '2d', session: 'agent-1', tool: 'send', decision: 'error', reason: 'runtime unavailable' };
    expect(isEnforceLine(line)).toBe(true);
  });

  it('orderKeys puts keys in canonical order and drops undefined', () => {
    const line: EnforceLine = { decision: 'allow', tool: 'drive_read', kind: 'enforce', session: 'agent-1', step: 'read', reason: undefined, file: '01-x.txt' };
    expect(JSON.stringify(orderKeys(line, ENFORCE_KEYS))).toBe(
      '{"kind":"enforce","step":"read","session":"agent-1","tool":"drive_read","file":"01-x.txt","decision":"allow"}',
    );
  });

  it('rejects malformed lines', () => {
    expect(isClassifyLine({ kind: 'classify', file: 'x', label: 'Secret', rule: 'jev' })).toBe(false);
    expect(isClassifyLine({ kind: 'classify', file: 'x', label: 'Legal', rule: 'jev', extra: 1 })).toBe(false);
    expect(isEnforceLine({ kind: 'enforce', step: '2a', session: 'agent-3', tool: 'send', decision: 'deny' })).toBe(false);
    expect(isEnforceLine({ kind: 'enforce', step: '2a', session: 'agent-1', tool: 'send', decision: 'maybe' })).toBe(false);
    expect(isOutboxLine({ to: 'legal@hashirai-poc.test', subject: 's', attachments: [], session: 'agent-1' })).toBe(false);
    expect(isDecisionLine(null)).toBe(false);
  });
});
