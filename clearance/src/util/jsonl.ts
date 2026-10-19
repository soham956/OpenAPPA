// JSON Lines helpers shared by the decision log, the outbox and compare.
// Synchronous on purpose: one appendFileSync per line keeps ordering simple
// and a crash never leaves a half-written line from interleaved writers.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonlParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    cause: unknown,
  ) {
    super(`${file}:${line}: invalid JSON line (${cause instanceof Error ? cause.message : String(cause)})`);
    this.name = 'JsonlParseError';
  }
}

/** Serialise one value as a single JSONL line (no trailing newline). Key order is preserved. */
export function toJsonlLine(value: unknown): string {
  const line = JSON.stringify(value);
  if (line === undefined) throw new TypeError('value is not JSON-serialisable');
  return line;
}

/** Parse JSONL text. Blank lines are skipped; a bad line throws with its 1-based line number. */
export function parseJsonl<T = unknown>(text: string, source = '<text>'): T[] {
  const out: T[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '') continue;
    try {
      out.push(JSON.parse(raw) as T);
    } catch (err) {
      throw new JsonlParseError(source, i + 1, err);
    }
  }
  return out;
}

/** Append one line, creating parent directories and the file as needed. */
export function appendJsonl(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, toJsonlLine(value) + '\n', 'utf8');
}

/** Read every line of a JSONL file. A missing file reads as empty. */
export function readJsonl<T = unknown>(file: string): T[] {
  if (!existsSync(file)) return [];
  return parseJsonl<T>(readFileSync(file, 'utf8'), file);
}

/** Replace a JSONL file with the given rows (an empty array leaves an empty file). */
export function writeJsonl(file: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => toJsonlLine(r) + '\n').join(''), 'utf8');
}
