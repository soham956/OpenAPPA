// Run comparison for `npm run compare`.
//   compare <runA> <runB>            two runs must be identical
//   compare --expected <run> [file]  one run against expected-decisions.json
// A run folder holds decisions.jsonl and outbox.jsonl (directly, or under logs/).
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CLEARANCE_DIR } from '../config';
import { readJsonl } from '../util/jsonl';
import { DecisionLog } from './decision-log';
import { isOutboxLine, type ClassifyLine, type DecisionLine, type EnforceLine, type OutboxLine } from './schema';

/** Fields that legitimately differ between runs. */
const IGNORED = ['ts', 'fileId', 'offerId'] as const;

export interface RunLogs {
  classify: ClassifyLine[];
  enforce: EnforceLine[];
  outbox: OutboxLine[];
}

export interface Difference {
  /** Which section and 1-based position, e.g. `classify #3`. */
  where: string;
  a: string;
  b: string;
}

export class CompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompareError';
  }
}

function logDir(runDir: string): string {
  const dir = resolve(runDir);
  if (existsSync(join(dir, 'decisions.jsonl')) || !existsSync(join(dir, 'logs'))) return dir;
  return join(dir, 'logs');
}

function strip<T extends object>(line: T): T {
  const copy = { ...line } as Record<string, unknown>;
  for (const k of IGNORED) delete copy[k];
  return copy as T;
}

/** Load a run, drop ignored fields and sort classify lines by file name. */
export function loadRun(runDir: string): RunLogs {
  const dir = logDir(runDir);
  const decisionsPath = join(dir, 'decisions.jsonl');
  const outboxPath = join(dir, 'outbox.jsonl');
  if (!existsSync(decisionsPath)) throw new CompareError(`${decisionsPath}: not found`);
  const lines: DecisionLine[] = new DecisionLog({ path: decisionsPath }).readAll();
  const outboxRows = readJsonl(outboxPath);
  outboxRows.forEach((row, i) => {
    if (!isOutboxLine(row)) throw new CompareError(`${outboxPath}: line ${i + 1} is not a valid outbox line`);
  });
  return {
    classify: lines
      .filter((l): l is ClassifyLine => l.kind === 'classify')
      .map(strip)
      .sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)),
    enforce: lines.filter((l): l is EnforceLine => l.kind === 'enforce').map(strip),
    outbox: (outboxRows as OutboxLine[]).map(strip),
  };
}

const show = (v: unknown): string => (v === undefined ? '(missing)' : JSON.stringify(v));

function diffSection(name: string, a: readonly unknown[], b: readonly unknown[]): Difference | undefined {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return { where: `${name} #${i + 1}`, a: show(a[i]), b: show(b[i]) };
    }
  }
  return undefined;
}

/** First difference between two runs, or undefined when they are identical. */
export function compareRuns(runA: string, runB: string): Difference | undefined {
  const a = loadRun(runA);
  const b = loadRun(runB);
  return (
    diffSection('classify', a.classify, b.classify) ??
    diffSection('enforce', a.enforce, b.enforce) ??
    diffSection('outbox', a.outbox, b.outbox)
  );
}

export interface Expected {
  classify: Record<string, unknown>[];
  enforce: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
}

export function loadExpected(file: string): Expected {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const rec = raw as Record<string, unknown>;
  for (const k of ['classify', 'enforce', 'outbox']) {
    if (typeof raw !== 'object' || raw === null || !Array.isArray(rec[k])) {
      throw new CompareError(`${file}: "${k}" must be an array`);
    }
  }
  return rec as unknown as Expected;
}

/** Every key in `want` must equal the same key in `got`; other keys of `got` are not checked. */
function matchesSubset(want: Record<string, unknown>, got: unknown): boolean {
  if (typeof got !== 'object' || got === null) return false;
  const g = got as Record<string, unknown>;
  return Object.entries(want).every(([k, v]) => JSON.stringify(v) === JSON.stringify(g[k]));
}

function checkSection(name: string, want: readonly Record<string, unknown>[], got: readonly unknown[]): Difference | undefined {
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    const w = want[i];
    const g = got[i];
    if (w === undefined || g === undefined || !matchesSubset(w, g)) {
      return { where: `${name} #${i + 1}`, a: show(w), b: show(g) };
    }
  }
  return undefined;
}

/** First mismatch between a run and the expected file, or undefined when it conforms. */
export function checkExpected(runDir: string, expectedFile: string): Difference | undefined {
  const run = loadRun(runDir);
  const exp = loadExpected(expectedFile);
  return (
    checkSection('classify', exp.classify, run.classify) ??
    checkSection('enforce', exp.enforce, run.enforce) ??
    checkSection('outbox', exp.outbox, run.outbox)
  );
}

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = 'usage: compare <runA> <runB>\n       compare --expected <run> [expected-decisions.json]';

/** CLI body. Returns the exit code: 0 ok, 1 difference, 2 usage or unreadable input. */
export function runCompareCli(argv: readonly string[], io: CliIo = { out: console.log, err: console.error }): number {
  try {
    if (argv[0] === '--expected') {
      const [run, file] = [argv[1], argv[2] ?? join(CLEARANCE_DIR, 'expected-decisions.json')];
      if (run === undefined || argv.length > 3) {
        io.err(USAGE);
        return 2;
      }
      const d = checkExpected(run, file);
      if (!d) {
        io.out('matches expected');
        return 0;
      }
      io.out(`differs from expected at ${d.where}\n  expected: ${d.a}\n  actual:   ${d.b}`);
      return 1;
    }
    if (argv.length !== 2 || argv.some((a) => a.startsWith('--'))) {
      io.err(USAGE);
      return 2;
    }
    const d = compareRuns(argv[0]!, argv[1]!);
    if (!d) {
      io.out('identical');
      return 0;
    }
    io.out(`differs at ${d.where}\n  A: ${d.a}\n  B: ${d.b}`);
    return 1;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 2;
  }
}
