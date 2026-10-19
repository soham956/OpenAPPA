import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOutboxLine } from '../src/log/schema';
import { send, type SendArgs } from '../src/tools/send';

let dir: string;
let outboxPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clearance-send-'));
  outboxPath = join(dir, 'logs', 'outbox.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('send', () => {
  it('appends exactly one line in schema key order, without body', () => {
    send(
      { to: ['legal@hashirai-poc.test'], subject: 'Legal documents for review', body: 'hi', attachments: ['01-a', '02-b'] },
      { session: 'agent-1', outboxPath },
    );
    expect(readFileSync(outboxPath, 'utf8')).toBe(
      '{"to":["legal@hashirai-poc.test"],"subject":"Legal documents for review","attachments":["01-a","02-b"],"session":"agent-1"}\n',
    );
  });

  it('defaults attachments to [] and appends across calls', () => {
    send({ to: ['a@x.test'], subject: 's' }, { session: 'agent-2', outboxPath });
    send({ to: ['b@x.test'], subject: 't' }, { session: 'agent-2', outboxPath });
    const lines = readFileSync(outboxPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);
    expect(lines).toHaveLength(2);
    expect(lines.every(isOutboxLine)).toBe(true);
    expect((lines[0] as { attachments: string[] }).attachments).toEqual([]);
  });

  it.each([
    ['empty to', { to: [], subject: 's' }],
    ['string to', { to: 'a@x.test', subject: 's' }],
    ['missing subject', { to: ['a@x.test'] }],
    ['bad attachments', { to: ['a@x.test'], subject: 's', attachments: [1] }],
    ['bad body', { to: ['a@x.test'], subject: 's', body: 5 }],
  ])('throws and writes nothing on %s', (_n, args) => {
    expect(() => send(args as unknown as SendArgs, { session: 'agent-1', outboxPath })).toThrow(TypeError);
    expect(existsSync(outboxPath)).toBe(false);
  });

  it('throws and writes nothing without a session', () => {
    expect(() => send({ to: ['a@x.test'], subject: 's' }, { session: '' as never, outboxPath })).toThrow(TypeError);
    expect(existsSync(outboxPath)).toBe(false);
  });

  it('leaves earlier lines intact when a later call throws', () => {
    send({ to: ['a@x.test'], subject: 's' }, { session: 'agent-1', outboxPath });
    const before = readFileSync(outboxPath, 'utf8');
    expect(() => send({ to: [], subject: 's' }, { session: 'agent-1', outboxPath })).toThrow();
    expect(readFileSync(outboxPath, 'utf8')).toBe(before);
  });
});
