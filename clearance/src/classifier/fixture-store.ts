// Recorded Jev answers keyed by sha256(content) (docs/demo-script.md,
// Determinism). In `replay` mode a hit is used as is and a miss calls Jev live
// and is recorded. In `live` mode Jev is always called and the answer
// re-recorded (used by fixture:record). The file name is stored only as a note.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClassifierMode } from '../config';
import { JEV_LABELS } from '../log/schema';
import type { AnswerSource, FixtureEntry, FixtureFile, Jev, JevAnswer, SourcedAnswer } from './types';

export class FixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureError';
  }
}

/** Raised on a fixture miss when no Jev is available (no TYPESAFE_API_KEY). */
export class MissingJevError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingJevError';
  }
}

/** Hex sha256 of the UTF-8 content. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const HASH = /^[0-9a-f]{64}$/;

function checkAnswer(v: unknown, where: string): JevAnswer {
  const r = v as Partial<JevAnswer> | null;
  if (
    typeof r !== 'object' ||
    r === null ||
    !(JEV_LABELS as readonly unknown[]).includes(r.label) ||
    typeof r.confidence !== 'number' ||
    !(r.confidence >= 0 && r.confidence <= 1)
  ) {
    throw new FixtureError(`${where}: expected {label: ${JEV_LABELS.join('|')}, confidence: 0..1}, got ${JSON.stringify(v)}`);
  }
  return { label: r.label as JevAnswer['label'], confidence: r.confidence };
}

/** Parse and validate fixture JSON text. */
export function parseFixture(text: string, path = 'fixture'): FixtureFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new FixtureError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new FixtureError(`${path} must be a JSON object of sha256 → {label, confidence, note}`);
  }
  const out: FixtureFile = {};
  for (const [hash, v] of Object.entries(raw)) {
    if (!HASH.test(hash)) throw new FixtureError(`${path}: key ${hash} is not a lowercase sha256 hex digest`);
    const ans = checkAnswer(v, `${path}[${hash.slice(0, 12)}…]`);
    const note = (v as { note?: unknown }).note;
    if (note !== undefined && typeof note !== 'string') throw new FixtureError(`${path}[${hash.slice(0, 12)}…]: note must be a string`);
    out[hash] = note === undefined ? ans : { ...ans, note };
  }
  return out;
}

/** Serialise with keys sorted by hash and a fixed field order, plus trailing newline. */
export function serializeFixture(entries: FixtureFile): string {
  const sorted: FixtureFile = {};
  for (const hash of Object.keys(entries).sort()) {
    const e = entries[hash]!;
    sorted[hash] = e.note === undefined ? { label: e.label, confidence: e.confidence } : { label: e.label, confidence: e.confidence, note: e.note };
  }
  return JSON.stringify(sorted, null, 2) + '\n';
}

export interface FixtureStoreOptions {
  /** Fixture file. Read if present; misses are recorded here. Default in callers: config.paths.fixturesFile. */
  path: string;
  /** Live Jev; undefined when there is no TYPESAFE_API_KEY. Receives content only. */
  jev?: Jev;
  /** Default `replay`. */
  mode?: ClassifierMode;
}

export class FixtureStore implements AnswerSource {
  readonly path: string;
  readonly mode: ClassifierMode;
  private readonly jev: Jev | undefined;
  private readonly entries: Map<string, FixtureEntry>;

  constructor(opts: FixtureStoreOptions) {
    this.path = opts.path;
    this.mode = opts.mode ?? 'replay';
    this.jev = opts.jev;
    const file = existsSync(opts.path) ? parseFixture(readFileSync(opts.path, 'utf8'), opts.path) : {};
    this.entries = new Map(Object.entries(file));
  }

  /** The recorded entry for this content, if any. */
  get(content: string): FixtureEntry | undefined {
    return this.entries.get(sha256(content));
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Jev's answer for `content`. `note` (the file name) is stored in the
   * fixture for humans and is never passed to Jev.
   */
  async answer(content: string, note?: string): Promise<SourcedAnswer> {
    const hash = sha256(content);
    const hit = this.entries.get(hash);
    if (hit && this.mode === 'replay') {
      return { label: hit.label, confidence: hit.confidence, source: 'fixture' };
    }
    if (!this.jev) {
      const what = note ? `"${note}"` : 'this content';
      const why = hit
        ? `CLASSIFIER_MODE=live needs Jev for ${what}`
        : `No recorded classification for ${what} (sha256 ${hash.slice(0, 12)}…) in ${this.path}`;
      throw new MissingJevError(
        `${why}, and Jev can't be called live because TYPESAFE_API_KEY is not set. ` +
          'Set the key in the repo-root .env, or record the fixture with `npm run fixture:record`.',
      );
    }
    const ans = checkAnswer(await this.jev(content), 'Jev answer');
    this.entries.set(hash, note === undefined ? ans : { ...ans, note });
    this.save();
    return { ...ans, source: 'live' };
  }

  /** Write all entries, sorted by hash (atomic rename). */
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, serializeFixture(Object.fromEntries(this.entries)));
    renameSync(tmp, this.path);
  }
}
