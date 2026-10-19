import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryLoad, memorySave } from '../src/tools/memory';

let dir: string;
let memoryPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clearance-memory-'));
  memoryPath = join(dir, 'state', 'memory.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('memory', () => {
  it('saves {value, origin} keyed by scope and loads it back', () => {
    memorySave({ scope: 'legal-handoff', value: 'LM-2026-0417' }, { origin: 'agent-1', memoryPath });
    expect(JSON.parse(readFileSync(memoryPath, 'utf8'))).toEqual({
      'legal-handoff': { value: 'LM-2026-0417', origin: 'agent-1' },
    });
    expect(memoryLoad({ scope: 'legal-handoff' }, { memoryPath })).toEqual({ value: 'LM-2026-0417', origin: 'agent-1' });
  });

  it('keeps other scopes and overwrites the same scope', () => {
    memorySave({ scope: 'a', value: '1' }, { origin: 'agent-1', memoryPath });
    memorySave({ scope: 'b', value: '2' }, { origin: 'agent-2', memoryPath });
    memorySave({ scope: 'a', value: '3' }, { origin: 'agent-2', memoryPath });
    expect(memoryLoad({ scope: 'a' }, { memoryPath })).toEqual({ value: '3', origin: 'agent-2' });
    expect(memoryLoad({ scope: 'b' }, { memoryPath })).toEqual({ value: '2', origin: 'agent-2' });
  });

  it('returns null for a missing scope or a missing file', () => {
    expect(memoryLoad({ scope: 'x' }, { memoryPath })).toBeNull();
    memorySave({ scope: 'a', value: '1' }, { origin: 'agent-1', memoryPath });
    expect(memoryLoad({ scope: 'x' }, { memoryPath })).toBeNull();
    expect(memoryLoad({ scope: 'toString' }, { memoryPath })).toBeNull();
  });

  it('treats an empty file as an empty store', () => {
    const empty = join(dir, 'e.json');
    writeFileSync(empty, '');
    expect(memoryLoad({ scope: 'a' }, { memoryPath: empty })).toBeNull();
  });

  it('rejects bad arguments without writing', () => {
    expect(() => memorySave({ scope: '', value: 'v' }, { origin: 'agent-1', memoryPath })).toThrow(TypeError);
    expect(() => memorySave({ scope: 's', value: 1 as unknown as string }, { origin: 'agent-1', memoryPath })).toThrow(TypeError);
    expect(() => memorySave({ scope: 's', value: 'v' }, { origin: '' as never, memoryPath })).toThrow(TypeError);
    expect(() => memoryLoad({ scope: '' }, { memoryPath })).toThrow(TypeError);
    expect(existsSync(memoryPath)).toBe(false);
  });
});
