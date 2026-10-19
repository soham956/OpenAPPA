// T6.1: the committed Jev fixture replays the demo-script classification for
// all 11 seeds with no TypeSafe key and without ever calling Jev.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createClassifier } from '../src/classifier/decide';
import { parseFixture } from '../src/classifier/fixture-store';
import type { Jev } from '../src/classifier/types';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const FIXTURE = join(root, 'fixtures', 'classifications.json');

const EXPECTED: Array<[string, string, string]> = [
  ['seed/01-mutual-nda-kestrel-orbit.txt', 'Legal', 'jev'],
  ['seed/02-master-services-agreement.txt', 'Legal', 'jev'],
  ['seed/03-cease-and-desist-letter.txt', 'Legal', 'jev'],
  ['seed/04-board-resolution-oct.txt', 'Legal', 'jev'],
  ['seed/05-invoice-0193.txt', 'Accounting', 'jev'],
  ['seed/06-q3-expense-report.txt', 'Accounting', 'jev'],
  ['seed/07-trial-balance-sept.txt', 'Accounting', 'jev'],
  ['seed/08-employment-contract-r-okafor.txt', 'High Risk', 'specimen-id'],
  ['seed/09-payslip-sept-m-lindqvist.txt', 'High Risk', 'specimen-id'],
  ['seed/10-settlement-payment-schedule.txt', 'High Risk', 'low-confidence'],
  ['seed/new/11-vendor-invoice-0207.txt', 'Accounting', 'jev'],
];

describe('recorded Jev fixture (replay, no key)', () => {
  it('holds exactly the 9 non-ID files', () => {
    expect(Object.keys(parseFixture(readFileSync(FIXTURE, 'utf8'), FIXTURE))).toHaveLength(9);
  });

  it('gives the demo-script label and rule for all 11 seeds and never calls Jev', async () => {
    const jev = vi.fn<Jev>(async () => {
      throw new Error('Jev must not be called in replay');
    });
    const classifyDoc = createClassifier({ fixturePath: FIXTURE, jev, mode: 'replay', threshold: 0.7 });
    for (const [path, label, rule] of EXPECTED) {
      const content = readFileSync(join(root, path), 'utf8');
      const r = await classifyDoc({ content, file: path.split('/').pop()! });
      expect(r.label, path).toBe(label);
      expect(r.rule, path).toBe(rule);
      if (rule === 'specimen-id') {
        expect(r.source, path).toBeUndefined();
      } else {
        expect(r.source, path).toBe('fixture');
        if (rule === 'jev') expect(r.confidence!, path).toBeGreaterThanOrEqual(0.7);
        else expect(r.confidence!, path).toBeLessThan(0.7);
      }
    }
    expect(jev).not.toHaveBeenCalled();
  });
});
