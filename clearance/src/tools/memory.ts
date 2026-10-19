// Local JSON memory store: state/memory.json, keyed by scope, entries {value, origin}.
// Plain functions; they never call APPA. `origin` (the saving session) comes from the
// caller, outside the APPA arguments. Owned by T11.1.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildPaths, CLEARANCE_DIR, REPO_ROOT } from '../config';
import { SESSIONS, type SessionId } from '../log/schema';

export interface MemoryEntry {
  value: string;
  origin: SessionId;
}

export interface MemoryContext {
  /** Memory file. Default: state/memory.json in clearance/. */
  memoryPath?: string;
}

export interface MemorySaveContext extends MemoryContext {
  origin: SessionId;
}

const defaultPath = () => buildPaths(REPO_ROOT, CLEARANCE_DIR).memoryFile;

function readStore(file: string): Record<string, MemoryEntry> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (text.trim() === '') return {};
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${file}: memory store must be a JSON object`);
  }
  return data as Record<string, MemoryEntry>;
}

/** Store `value` under `scope` (overwrites any earlier entry). Returns the stored entry. */
export function memorySave(args: { scope: string; value: string }, ctx: MemorySaveContext): MemoryEntry {
  if (typeof args.scope !== 'string' || args.scope === '') throw new TypeError('memory_save: "scope" must be a non-empty string');
  if (typeof args.value !== 'string') throw new TypeError('memory_save: "value" must be a string');
  if (!(SESSIONS as readonly unknown[]).includes(ctx?.origin)) throw new TypeError('memory_save: an origin session is required');

  const file = ctx.memoryPath ?? defaultPath();
  const store = readStore(file);
  const entry: MemoryEntry = { value: args.value, origin: ctx.origin };
  store[args.scope] = entry;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
  return entry;
}

/**
 * Load the entry for `scope`. A missing scope (or missing file) returns `null`, not an
 * error: "nothing saved yet" is a normal state, and the caller reports it.
 */
export function memoryLoad(args: { scope: string }, ctx: MemoryContext = {}): MemoryEntry | null {
  if (typeof args.scope !== 'string' || args.scope === '') throw new TypeError('memory_load: "scope" must be a non-empty string');
  const store = readStore(ctx.memoryPath ?? defaultPath());
  return Object.hasOwn(store, args.scope) ? store[args.scope]! : null;
}
