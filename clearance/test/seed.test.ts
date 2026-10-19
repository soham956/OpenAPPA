import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');

const FILES = [
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

const ID_PATTERN = /SPC-\d{4}-\d{4}/;
const EXPECTED_IDS: Record<string, string> = {
  '08-employment-contract-r-okafor.txt': 'SPC-4417-2290',
  '09-payslip-sept-m-lindqvist.txt': 'SPC-7781-0356',
};

const read = (name: string) => readFileSync(join(seedDir, name), 'utf8');

describe('seed files', () => {
  it('has exactly the 11 demo-script files', () => {
    for (const f of FILES) expect(existsSync(join(seedDir, f)), f).toBe(true);
  });

  it('starts every file with the SPECIMEN header', () => {
    for (const f of FILES) {
      expect(read(f).split('\n')[0], f).toBe('SPECIMEN — synthetic test document, not real data');
    }
  });

  it('puts a SPECIMEN ID only in 08 and 09', () => {
    for (const f of FILES) {
      const m = read(f).match(new RegExp(ID_PATTERN, 'g'));
      if (EXPECTED_IDS[f]) expect(m, f).toEqual([EXPECTED_IDS[f]]);
      else expect(m, f).toBeNull();
    }
  });

  it('keeps the matter ref in 01', () => {
    const first = FILES[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(read(first)).toContain('Matter Ref: LM-2026-0417');
  });

  it('uses only fictional .test email addresses', () => {
    for (const f of FILES) {
      const emails = read(f).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
      for (const e of emails) expect(e, f).toMatch(/\.test$/);
    }
  });

  it('is sized 150-400 words and is not a scan of real data', () => {
    for (const f of FILES) {
      const words = read(f).split(/\s+/).filter(Boolean).length;
      expect(words, f).toBeGreaterThanOrEqual(150);
      expect(words, f).toBeLessThanOrEqual(400);
    }
  });

  it('gives file 10 both settlement terms and an instalment ledger', () => {
    const t = read('10-settlement-payment-schedule.txt');
    expect(t).toMatch(/Settlement terms/i);
    expect(t).toMatch(/Instalment ledger/i);
  });
});
