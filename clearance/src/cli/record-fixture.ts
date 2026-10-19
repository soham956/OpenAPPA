// npm run fixture:record — classify all 11 seeds with live Jev and write
// fixtures/classifications.json (sha256(content) → {label, confidence, note}).
//
// Seeds 08 and 09 carry a SPECIMEN ID, so the ID rule fires first and Jev is
// never asked: they are listed in the summary but NOT recorded. The classifier
// never looks them up, so entries for them would be dead weight. The fixture
// therefore holds the 9 non-ID files (01–07, 10, 11).
//
// The fixture is rebuilt from scratch in a temp file and renamed into place
// only when every file succeeded, so a failed run keeps the old fixture and
// stale hashes from edited seeds don't linger.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Config, getConfig } from '../config';
import { classify } from '../classifier/decide';
import { FixtureStore } from '../classifier/fixture-store';
import { createTypesafeJev } from '../classifier/jev';
import type { Classification, Jev } from '../classifier/types';

export interface RecordOptions {
  cfg: Config;
  /** Default: live TypeSafe Jev from cfg. */
  jev?: Jev;
  /** Default: console.log. */
  log?: (line: string) => void;
}

export interface RecordResult {
  file: string;
  result: Classification;
  recorded: boolean;
}

/** seed/*.txt then seed/new/*.txt, each sorted by name. */
export function listSeeds(cfg: Config): string[] {
  const txt = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.txt'))
          .sort()
          .map((f) => join(dir, f))
      : [];
  return [...txt(cfg.paths.seedDir), ...txt(cfg.paths.newSeedDir)];
}

export async function recordFixture(opts: RecordOptions): Promise<RecordResult[]> {
  const { cfg } = opts;
  const log = opts.log ?? ((l: string) => console.log(l));
  if (!opts.jev) cfg.requireTypesafeKey(); // fail before any work: recording is always live
  const jev = opts.jev ?? createTypesafeJev({ cfg });

  const out = cfg.paths.fixturesFile;
  const tmp = `${out}.recording-${process.pid}`;
  rmSync(tmp, { force: true });
  const store = new FixtureStore({ path: tmp, jev, mode: 'live' });

  const results: RecordResult[] = [];
  try {
    for (const path of listSeeds(cfg)) {
      const file = basename(path);
      const content = readFileSync(path, 'utf8');
      const result = await classify({ content, file }, { answers: store, threshold: cfg.confidenceThreshold });
      const recorded = result.rule !== 'specimen-id';
      results.push({ file, result, recorded });
      log(summarize(file, result, recorded));
    }
    mkdirSync(dirname(out), { recursive: true });
    if (store.size === 0) throw new Error('No Jev answers were recorded; refusing to write an empty fixture.');
    store.save();
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
  log(`Recorded ${store.size} of ${results.length} files into ${out} (ID-rule files are not recorded).`);
  return results;
}

function summarize(file: string, r: Classification, recorded: boolean): string {
  const jev = r.jev === undefined ? 'Jev skipped' : `jev=${r.jev} confidence=${r.confidence}`;
  return `${file.padEnd(40)} ${r.label.padEnd(10)} ${r.rule.padEnd(14)} ${jev}  ${recorded ? 'recorded' : 'not recorded'}`;
}

async function main(): Promise<void> {
  try {
    await recordFixture({ cfg: getConfig() });
  } catch (e) {
    console.error(`fixture:record failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
