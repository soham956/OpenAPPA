// Demo step 2 end to end: the real appa sidecar, the real guard and agent CLI, a fake Drive.
// Skipped only when APPA_BIN is absent AND CLEARANCE_REQUIRE_APPA is unset; CI sets both.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkExpected, compareRuns } from '../../src/log/compare';
import { isOutboxLine } from '../../src/log/schema';
import { parseJsonl } from '../../src/util/jsonl';
import { EXPECTED_FILE, LIVE, type Step2Run, processAlive, runStep2, step2ExpectedFile } from './helpers';

const LEGAL = [
  '01-mutual-nda-kestrel-orbit.txt',
  '02-master-services-agreement.txt',
  '03-cease-and-desist-letter.txt',
  '04-board-resolution-oct.txt',
];

describe.skipIf(!LIVE)('demo step 2 end to end (real appa sidecar, fake Drive)', () => {
  let first: Step2Run;
  let second: Step2Run;

  beforeAll(async () => {
    first = await runStep2();
    second = await runStep2(); // fresh temp root, fresh appa DB
  }, 90_000);

  afterAll(() => {
    for (const run of [first, second]) if (run) rmSync(run.root, { recursive: true, force: true });
  });

  it('runs the whole script and exits 0', () => {
    expect(first.exitCode, first.printed.join('\n')).toBe(0);
    expect(first.printed.some((l) => l.startsWith('[agent-1] 2d send') && l.endsWith(': allow'))).toBe(true);
  });

  it('enforce lines and outbox pass compare --expected', () => {
    expect(checkExpected(first.logsDir, step2ExpectedFile(first.root))).toBeUndefined();
    // Sanity: the expected file used is Mika's, with only the classify section dropped.
    const expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')) as { enforce: unknown[] };
    expect(expected.enforce).toHaveLength(11);
  });

  it('the outbox holds exactly the 2d line', () => {
    const rows = parseJsonl(readFileSync(join(first.logsDir, 'outbox.jsonl'), 'utf8'));
    expect(rows).toEqual([
      { to: ['legal@hashirai-poc.test'], subject: 'Legal documents for review', attachments: LEGAL, session: 'agent-1' },
    ]);
    expect(rows.every(isOutboxLine)).toBe(true);
  });

  it('a second run on a fresh DB gives identical lines (ignoring ts and ids)', () => {
    expect(second.exitCode, second.printed.join('\n')).toBe(0);
    expect(compareRuns(first.logsDir, second.logsDir)).toBeUndefined();
  });

  it('touches nothing outside the Drive tree and leaves no appa process behind', () => {
    for (const run of [first, second]) {
      expect(run.drive.outsideTreeIds()).toEqual([]);
      expect(run.pid).toBeTypeOf('number');
      expect(processAlive(run.pid)).toBe(false);
    }
  });
});
