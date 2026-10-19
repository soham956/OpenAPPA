// Root poller: every POLL_INTERVAL_MS it lists the Drive root, classifies each
// new file from its content only, moves it to its label's subfolder and writes
// one `classify` line. It never looks inside the subfolders.
//
// Seen file ids persist in state/poller.json, so a restart never logs a file
// twice. A file whose read, classify, move or log fails stays in the root, is
// not marked seen, and is retried on the next tick.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Classification, ClassifyInput } from '../classifier/types';
import { getConfig } from '../config';
import type { DriveClient, SubfolderKey } from '../drive/types';
import type { ClassifyLine, Label } from '../log/schema';

/** The classifier, as returned by `createClassifier()`. */
export type ClassifyFn = (input: ClassifyInput) => Promise<Classification>;

/** The part of DecisionLog the poller uses. */
export interface ClassifyLogWriter {
  writeClassify(line: Omit<ClassifyLine, 'kind' | 'ts'>): ClassifyLine;
}

/** Destination subfolder for each label. */
export const LABEL_FOLDER: Readonly<Record<Label, SubfolderKey>> = {
  Legal: 'legal',
  Accounting: 'accounting',
  'High Risk': 'high-risk',
};

export interface PollerOptions {
  drive: DriveClient;
  classify: ClassifyFn;
  log: ClassifyLogWriter;
  /** Seen-ids state file. Default: `getConfig().paths.pollerState`. */
  statePath?: string;
  /** Tick interval. Default: `getConfig().pollIntervalMs`. */
  intervalMs?: number;
  /** Called once per failed file (default: console.error). */
  onError?: (err: unknown, file: { id: string; name: string }) => void;
}

/** One file the poller handled successfully in a tick. */
export interface TickMoved {
  fileId: string;
  line: ClassifyLine;
}

export interface TickFailed {
  fileId: string;
  file: string;
  error: unknown;
}

export interface TickResult {
  moved: TickMoved[];
  failed: TickFailed[];
}

interface PollerStateFile {
  seen: string[];
}

function readSeen(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PollerStateFile>;
  if (!Array.isArray(parsed.seen) || !parsed.seen.every((s) => typeof s === 'string')) {
    throw new Error(`${path}: expected {"seen": string[]}`);
  }
  return new Set(parsed.seen);
}

function writeSeen(path: string, seen: Set<string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body: PollerStateFile = { seen: [...seen].sort() };
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(tmp, path);
}

export class Poller {
  private readonly drive: DriveClient;
  private readonly classifyFn: ClassifyFn;
  private readonly log: ClassifyLogWriter;
  private readonly statePath: string;
  private readonly intervalMs: number;
  private readonly onError: NonNullable<PollerOptions['onError']>;
  private readonly seen: Set<string>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<unknown> | undefined;

  constructor(opts: PollerOptions) {
    this.drive = opts.drive;
    this.classifyFn = opts.classify;
    this.log = opts.log;
    this.statePath = opts.statePath ?? getConfig().paths.pollerState;
    this.intervalMs = opts.intervalMs ?? getConfig().pollIntervalMs;
    this.onError =
      opts.onError ??
      ((err, file) => console.error(`poller: ${file.name} (${file.id}) failed, will retry:`, err));
    this.seen = readSeen(this.statePath);
  }

  /** Ids already classified and moved (persisted). */
  seenIds(): string[] {
    return [...this.seen].sort();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** One pass over the root. Ticks never overlap: a call during a tick waits for it. */
  async tick(): Promise<TickResult> {
    while (this.inFlight) await this.inFlight.catch(() => undefined);
    const run = this.runTick();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runTick(): Promise<TickResult> {
    const result: TickResult = { moved: [], failed: [] };
    const files = await this.drive.listRoot();
    for (const f of files) {
      if (this.seen.has(f.id)) continue;
      try {
        const { content } = await this.drive.read(f.id);
        // Content only: the file name is passed for fixture notes, never decides the label.
        const c = await this.classifyFn({ content, file: f.name });
        await this.drive.move(f.id, LABEL_FOLDER[c.label]);
        const line = this.log.writeClassify({ file: f.name, ...c, moved: c.label, fileId: f.id });
        this.seen.add(f.id);
        writeSeen(this.statePath, this.seen);
        result.moved.push({ fileId: f.id, line });
      } catch (error) {
        result.failed.push({ fileId: f.id, file: f.name, error });
        this.onError(error, f);
      }
    }
    return result;
  }

  /** Tick now, then every `intervalMs` after each tick finishes. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.tick();
    } catch (err) {
      // listRoot failed (e.g. network); try again next interval.
      console.error('poller: tick failed, will retry:', err);
    }
    if (this.running) this.timer = setTimeout(() => void this.loop(), this.intervalMs);
  }

  /** Stop the loop and wait for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.inFlight) await this.inFlight.catch(() => undefined);
  }
}

export function createPoller(opts: PollerOptions): Poller {
  return new Poller(opts);
}
