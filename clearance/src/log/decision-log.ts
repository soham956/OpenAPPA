// Decision log writer and reader (logs/decisions.jsonl).
// One line per call, stamped with `ts`, keys in the demo-script order from schema.ts.
import { getConfig } from '../config';
import { appendJsonl, readJsonl } from '../util/jsonl';
import {
  CLASSIFY_KEYS,
  ENFORCE_KEYS,
  isDecisionLine,
  orderKeys,
  type ClassifyLine,
  type DecisionLine,
  type EnforceLine,
} from './schema';

export interface DecisionLogOptions {
  /** Log file path. Defaults to `getConfig().paths.decisionsLog`, resolved on first use. */
  path?: string;
  /** Clock for `ts`; injectable for tests. */
  now?: () => Date;
}

export class DecisionLogFormatError extends Error {
  constructor(
    readonly file: string,
    readonly index: number,
  ) {
    super(`${file}: line ${index + 1} is not a valid decision line`);
    this.name = 'DecisionLogFormatError';
  }
}

export class DecisionLog {
  private resolvedPath: string | undefined;
  private readonly now: () => Date;

  constructor(private readonly opts: DecisionLogOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  get path(): string {
    this.resolvedPath ??= this.opts.path ?? getConfig().paths.decisionsLog;
    return this.resolvedPath;
  }

  /** Append one line. Any `ts` on the input is replaced. Returns the line as written. */
  write<T extends DecisionLine>(line: T): T {
    const stamped = { ...line, ts: this.now().toISOString() } as T;
    const ordered =
      stamped.kind === 'classify'
        ? (orderKeys(stamped as ClassifyLine, CLASSIFY_KEYS) as ClassifyLine)
        : (orderKeys(stamped as EnforceLine, ENFORCE_KEYS) as EnforceLine);
    if (!isDecisionLine(ordered)) {
      throw new TypeError(`invalid decision line: ${JSON.stringify(line)}`);
    }
    appendJsonl(this.path, ordered);
    return ordered as T;
  }

  writeClassify(line: Omit<ClassifyLine, 'kind' | 'ts'>): ClassifyLine {
    return this.write({ kind: 'classify', ...line });
  }

  writeEnforce(line: Omit<EnforceLine, 'kind' | 'ts'>): EnforceLine {
    return this.write({ kind: 'enforce', ...line });
  }

  /** Read every line back, validated and typed. A missing file reads as empty. */
  readAll(): DecisionLine[] {
    const rows = readJsonl(this.path);
    rows.forEach((row, i) => {
      if (!isDecisionLine(row)) throw new DecisionLogFormatError(this.path, i);
    });
    return rows as DecisionLine[];
  }

  readClassify(): ClassifyLine[] {
    return this.readAll().filter((l): l is ClassifyLine => l.kind === 'classify');
  }

  readEnforce(): EnforceLine[] {
    return this.readAll().filter((l): l is EnforceLine => l.kind === 'enforce');
  }
}

export function createDecisionLog(opts: DecisionLogOptions = {}): DecisionLog {
  return new DecisionLog(opts);
}
