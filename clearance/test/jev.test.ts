import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK is mocked in every test: TypeSafeClient never touches the network.
// choice() stays real so the question shape is the SDK's own.
const systemOne = vi.fn();
const ctor = vi.fn();
vi.mock('@typesafe-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@typesafe-ai/sdk')>();
  class TypeSafeClient {
    constructor(config: unknown) {
      ctor(config);
    }
    systemOne = systemOne;
  }
  return { ...real, TypeSafeClient };
});

const { ConfigError, loadConfig } = await import('../src/config');
const { createTypesafeJev, jevFromConfig, JevError, JEV_QUESTION, toJevAnswer } = await import('../src/classifier/jev');
const { parseFixture, sha256, serializeFixture } = await import('../src/classifier/fixture-store');
const { recordFixture } = await import('../src/cli/record-fixture');

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
// Synthetic, and not written as an env-file assignment (CI's secret scan).
const KEY = 'synthetic-test-key';

const reply = (choice: string, confidence: number) => ({
  model: 'jev-latest',
  answers: { category: { type: 'choice', choice, confidence, probabilities: {} } },
  usage: { input_tokens: null, output_tokens: null },
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clearance-jev-'));
  systemOne.mockReset();
  ctor.mockReset();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const cfgWith = (env: Record<string, string>) => loadConfig({ repoRoot: root, env });

describe('TypeSafe Jev adapter', () => {
  it('sends only the content, as one {Legal, Accounting} choice question', async () => {
    systemOne.mockResolvedValue(reply('Accounting', 0.91));
    const jev = createTypesafeJev({ cfg: cfgWith({ TYPESAFE_API_KEY: KEY }) });
    const content = readFileSync(join(seedDir, '05-invoice-0193.txt'), 'utf8');

    expect(await jev(content)).toEqual({ label: 'Accounting', confidence: 0.91 });
    expect(ctor).toHaveBeenCalledWith({ apiKey: KEY });
    expect(systemOne).toHaveBeenCalledTimes(1);
    const [request, ...rest] = systemOne.mock.calls[0]!;
    expect(rest).toEqual([]);
    expect(request).toEqual({ state: content, questions: { category: JEV_QUESTION } });
    expect(request.questions.category.type).toBe('choice');
    expect(Object.keys(request.questions.category.criteria)).toEqual(['Legal', 'Accounting']);
    expect(JSON.stringify(request)).not.toContain('invoice-0193');
  });

  it('passes a model override when given', async () => {
    systemOne.mockResolvedValue(reply('Legal', 0.8));
    await createTypesafeJev({ cfg: cfgWith({ TYPESAFE_API_KEY: KEY }), model: 'jev-x' })('text');
    expect(systemOne.mock.calls[0]![0].model).toBe('jev-x');
  });

  it('creates the client once and reuses it', async () => {
    systemOne.mockResolvedValue(reply('Legal', 0.8));
    const jev = createTypesafeJev({ cfg: cfgWith({ TYPESAFE_API_KEY: KEY }) });
    await jev('a');
    await jev('b');
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(systemOne).toHaveBeenCalledTimes(2);
  });

  it('a missing key errors only when a live call is made', async () => {
    const cfg = cfgWith({});
    const jev = createTypesafeJev({ cfg });
    expect(ctor).not.toHaveBeenCalled();
    await expect(jev('x')).rejects.toThrow(ConfigError);
    await expect(jev('x')).rejects.toThrow(/TYPESAFE_API_KEY is not set/);
    expect(systemOne).not.toHaveBeenCalled();
    expect(jevFromConfig(cfg)).toBeUndefined();
    expect(jevFromConfig(cfgWith({ TYPESAFE_API_KEY: KEY }))).toBeTypeOf('function');
  });

  it('maps confidence to 0..1 and rejects labels outside {Legal, Accounting}', () => {
    expect(toJevAnswer({ choice: 'Legal', confidence: 0.58 })).toEqual({ label: 'Legal', confidence: 0.58 });
    expect(toJevAnswer({ choice: 'Legal', confidence: 1.0000001 }).confidence).toBe(1);
    expect(toJevAnswer({ choice: 'Accounting', confidence: -0.01 }).confidence).toBe(0);
    expect(() => toJevAnswer({ choice: 'Other', confidence: 0.9 })).toThrow(JevError);
    expect(() => toJevAnswer({ choice: 'Legal', confidence: Number.NaN })).toThrow(JevError);
  });
});

describe('fixture:record', () => {
  /** A temp clearance/ with copies of the real seeds. */
  function setup(env: Record<string, string>) {
    const clearanceDir = join(root, 'clearance');
    mkdirSync(clearanceDir, { recursive: true });
    cpSync(seedDir, join(clearanceDir, 'seed'), { recursive: true });
    return loadConfig({ repoRoot: root, clearanceDir, env });
  }

  // Deterministic stand-in answers keyed by seed file content.
  function answerBySeed() {
    const byHash = new Map<string, [string, number]>();
    const add = (f: string, l: string, c: number) => byHash.set(sha256(readFileSync(join(seedDir, f), 'utf8')), [l, c]);
    for (const f of ['01-mutual-nda-kestrel-orbit.txt', '02-master-services-agreement.txt', '03-cease-and-desist-letter.txt', '04-board-resolution-oct.txt']) add(f, 'Legal', 0.9);
    for (const f of ['05-invoice-0193.txt', '06-q3-expense-report.txt', '07-trial-balance-sept.txt', 'new/11-vendor-invoice-0207.txt']) add(f, 'Accounting', 0.93);
    add('10-settlement-payment-schedule.txt', 'Legal', 0.58);
    systemOne.mockImplementation(async (req: { state: string }) => {
      const a = byHash.get(sha256(req.state));
      if (!a) throw new Error('unexpected content sent to Jev');
      return reply(a[0], a[1]);
    });
  }

  it('records the 9 non-ID seeds, sorted by hash, with the file name as the note', async () => {
    const cfg = setup({ TYPESAFE_API_KEY: KEY });
    answerBySeed();
    const lines: string[] = [];
    const results = await recordFixture({ cfg, log: (l) => lines.push(l) });

    expect(results.map((r) => r.file)).toEqual([
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
      '11-vendor-invoice-0207.txt',
    ]);
    expect(systemOne).toHaveBeenCalledTimes(9);
    for (const [req] of systemOne.mock.calls) {
      for (const r of results) expect(JSON.stringify(req)).not.toContain(r.file);
    }

    const text = readFileSync(cfg.paths.fixturesFile, 'utf8');
    expect(text).toBe(serializeFixture(parseFixture(text)));
    const entries = parseFixture(text);
    const keys = Object.keys(entries);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toHaveLength(9);
    const notes = Object.values(entries).map((e) => e.note).sort();
    expect(notes).toEqual(results.filter((r) => r.recorded).map((r) => r.file).sort());
    expect(notes).not.toContain('08-employment-contract-r-okafor.txt');
    expect(notes).not.toContain('09-payslip-sept-m-lindqvist.txt');
    const ten = readFileSync(join(seedDir, '10-settlement-payment-schedule.txt'), 'utf8');
    expect(entries[sha256(ten)]).toEqual({ label: 'Legal', confidence: 0.58, note: '10-settlement-payment-schedule.txt' });

    expect(lines).toHaveLength(12);
    expect(lines[7]).toMatch(/^08-employment-contract-r-okafor\.txt\s+High Risk\s+specimen-id\s+Jev skipped\s+not recorded$/);
    expect(lines[9]).toMatch(/low-confidence\s+jev=Legal confidence=0.58\s+recorded$/);
    expect(lines[11]).toMatch(/^Recorded 9 of 11 files/);
    expect(readdirSync(dirname(cfg.paths.fixturesFile))).toEqual(['classifications.json']);
  });

  it('replaces stale entries instead of merging', async () => {
    const cfg = setup({ TYPESAFE_API_KEY: KEY });
    mkdirSync(dirname(cfg.paths.fixturesFile), { recursive: true });
    writeFileSync(cfg.paths.fixturesFile, serializeFixture({ [sha256('old')]: { label: 'Legal', confidence: 0.9, note: 'old.txt' } }));
    answerBySeed();
    await recordFixture({ cfg, log: () => {} });
    expect(parseFixture(readFileSync(cfg.paths.fixturesFile, 'utf8'))[sha256('old')]).toBeUndefined();
  });

  it('fails before any call without a key, and leaves no fixture', async () => {
    const cfg = setup({});
    await expect(recordFixture({ cfg, log: () => {} })).rejects.toThrow(/TYPESAFE_API_KEY is not set/);
    expect(systemOne).not.toHaveBeenCalled();
    expect(existsSync(cfg.paths.fixturesFile)).toBe(false);
  });

  it('keeps the old fixture when a call fails midway', async () => {
    const cfg = setup({ TYPESAFE_API_KEY: KEY });
    mkdirSync(dirname(cfg.paths.fixturesFile), { recursive: true });
    const before = serializeFixture({ [sha256('old')]: { label: 'Legal', confidence: 0.9, note: 'old.txt' } });
    writeFileSync(cfg.paths.fixturesFile, before);
    systemOne.mockResolvedValueOnce(reply('Legal', 0.9)).mockRejectedValueOnce(new Error('boom'));
    await expect(recordFixture({ cfg, log: () => {} })).rejects.toThrow('boom');
    expect(readFileSync(cfg.paths.fixturesFile, 'utf8')).toBe(before);
    expect(readdirSync(dirname(cfg.paths.fixturesFile))).toEqual(['classifications.json']);
  });
});
