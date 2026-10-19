import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentGuard, EXTERNAL, INTERNAL, runScript } from '../src/agent/script';
import { DEFAULT_TASK, main } from '../src/cli/agent';
import { CLEARANCE_DIR, loadConfig } from '../src/config';
import { FakeDriveClient } from '../src/drive/fake';
import type { EnforceLine, SessionId, Step, ToolName } from '../src/log/schema';
import type { GuardResult } from '../src/sidecar/guard';

const SEED = join(CLEARANCE_DIR, 'seed');
const LEGAL = [
  '01-mutual-nda-kestrel-orbit.txt',
  '02-master-services-agreement.txt',
  '03-cease-and-desist-letter.txt',
  '04-board-resolution-oct.txt',
];
const REASON_FILE = `Blocked: Legal content may only go to ${INTERNAL}. ${EXTERNAL} is outside that list.`;
const REASON_MEMORY = `Blocked: this memory entry came from Legal content, which may only go to ${INTERNAL}. ${EXTERNAL} is outside that list.`;

type Event =
  | { op: 'start'; session: SessionId; prompt: string }
  | { op: 'end'; session: SessionId }
  | { op: 'call'; session: SessionId; step: Step; tool: ToolName; args: unknown };

/**
 * A stub guard with the demo's decisions: the listing, reads and memory allowed, any send
 * that includes counsel denied with the session's reason, 2d allowed. Records every event.
 */
// Deliberately out of order: the agent reads in name order.
const defaultListing = () => [...LEGAL].reverse().map((name) => ({ id: `id-${name}`, name }));

function stubGuard(contents: Record<string, string>, listing: { id: string; name: string }[] = defaultListing(), listDecision: 'allow' | 'deny' = 'allow') {
  const nameOf = (id: string) => listing.find((f) => f.id === id)?.name ?? id;
  const events: Event[] = [];
  const memory = new Map<string, string>();
  const line = (session: SessionId, step: Step, tool: ToolName, decision: EnforceLine['decision']): EnforceLine => ({
    kind: 'enforce',
    step,
    session,
    tool,
    decision,
  });
  const guard: AgentGuard = {
    async start(session, prompt) {
      events.push({ op: 'start', session, prompt });
    },
    async end(session) {
      events.push({ op: 'end', session });
    },
    async call(session, step, tool, args) {
      events.push({ op: 'call', session, step, tool, args: structuredClone(args) });
      const a = args as Record<string, unknown>;
      const allow = (result: unknown) => ({ decision: 'allow', tool, result, line: line(session, step, tool, 'allow') }) as GuardResult<typeof tool>;
      switch (tool) {
        case 'drive_list':
          if (listDecision === 'deny') return { decision: 'deny', tool, reason: 'no', line: line(session, step, tool, 'deny') } as GuardResult<typeof tool>;
          return allow(listing.map((f) => ({ ...f })));
        case 'drive_read': {
          const name = nameOf(String(a.fileId));
          return allow({ name, content: contents[name] ?? '', folder: 'legal' });
        }
        case 'memory_save':
          memory.set(String(a.scope), String(a.value));
          return allow({ value: a.value, origin: session });
        case 'memory_load': {
          const v = memory.get(String(a.scope));
          return allow(v === undefined ? null : { value: v, origin: 'agent-1' });
        }
        case 'send': {
          if ((a.to as string[]).includes(EXTERNAL)) {
            const reason = session === 'agent-2' ? REASON_MEMORY : REASON_FILE;
            return { decision: 'deny', tool, reason, line: line(session, step, tool, 'deny') } as GuardResult<typeof tool>;
          }
          return allow({ to: a.to, subject: a.subject, attachments: a.attachments });
        }
        default:
          throw new Error(`unexpected tool ${tool}`);
      }
    },
  };
  return { guard, events };
}

const seedContents = () => Object.fromEntries(LEGAL.map((n) => [n, readFileSync(join(SEED, n), 'utf8')]));

describe('scripted agent', () => {
  it('makes the exact demo call sequence with the exact arguments', async () => {
    const { guard, events } = stubGuard(seedContents());
    const res = await runScript(DEFAULT_TASK, { guard, print: () => {} });
    expect(res.aborted).toBeUndefined();
    const ref = 'LM-2026-0417';
    expect(events).toEqual([
      { op: 'start', session: 'agent-1', prompt: DEFAULT_TASK },
      { op: 'call', session: 'agent-1', step: 'list', tool: 'drive_list', args: { folder: 'legal' } },
      ...LEGAL.map((name) => ({ op: 'call', session: 'agent-1', step: 'read', tool: 'drive_read', args: { fileId: `id-${name}` } })),
      {
        op: 'call', session: 'agent-1', step: '2a', tool: 'send',
        args: { to: [INTERNAL, EXTERNAL], subject: 'Legal documents for review', attachments: LEGAL },
      },
      { op: 'call', session: 'agent-1', step: '2b', tool: 'send', args: { to: [EXTERNAL], subject: 'Matter reference', body: ref } },
      { op: 'call', session: 'agent-1', step: '2c-save', tool: 'memory_save', args: { scope: 'legal-handoff', value: ref } },
      { op: 'start', session: 'agent-2', prompt: expect.stringContaining('legal-handoff') },
      { op: 'call', session: 'agent-2', step: '2c-load', tool: 'memory_load', args: { scope: 'legal-handoff' } },
      { op: 'call', session: 'agent-2', step: '2c', tool: 'send', args: { to: [EXTERNAL], subject: 'Matter reference', body: ref } },
      {
        op: 'call', session: 'agent-1', step: '2d', tool: 'send',
        args: { to: [INTERNAL], subject: 'Legal documents for review', attachments: LEGAL },
      },
      { op: 'end', session: 'agent-1' },
      { op: 'end', session: 'agent-2' },
    ]);
    expect(res.steps.map((s) => [s.step, s.decision])).toEqual([
      ['list', 'allow'],
      ['read', 'allow'], ['read', 'allow'], ['read', 'allow'], ['read', 'allow'],
      ['2a', 'deny'], ['2b', 'deny'], ['2c-save', 'allow'], ['2c-load', 'allow'], ['2c', 'deny'], ['2d', 'allow'],
    ]);
  });

  it('takes the matter reference from file 01 by regex, not a constant', async () => {
    const contents = seedContents();
    contents[LEGAL[0]!] = contents[LEGAL[0]!]!.replace('LM-2026-0417', 'LM-1999-0042');
    const { guard, events } = stubGuard(contents);
    await runScript(DEFAULT_TASK, { guard, print: () => {} });
    const bodies = events.flatMap((e) => (e.op === 'call' ? [(e.args as { body?: string; value?: string }).body ?? (e.args as { value?: string }).value] : []));
    expect(bodies.filter(Boolean)).toEqual(['LM-1999-0042', 'LM-1999-0042', 'LM-1999-0042']);
  });

  it('stops when the guarded listing is not allowed, reading nothing', async () => {
    const { guard, events } = stubGuard(seedContents(), defaultListing(), 'deny');
    const res = await runScript(DEFAULT_TASK, { guard, print: () => {} });
    expect(res.aborted).toMatch(/could not list/);
    expect(events.filter((e) => e.op === 'call').map((e) => (e as { tool: string }).tool)).toEqual(['drive_list']);
    expect(events.slice(-2)).toEqual([{ op: 'end', session: 'agent-1' }, { op: 'end', session: 'agent-2' }]);
  });

  it('prints each decision and reason', async () => {
    const lines: string[] = [];
    const { guard } = stubGuard(seedContents());
    await runScript(DEFAULT_TASK, { guard, print: (l) => lines.push(l) });
    expect(lines).toContain(`[agent-1] 2a send to ${INTERNAL}, ${EXTERNAL}: deny. ${REASON_FILE}`);
    expect(lines).toContain(`[agent-1] 2b send LM-2026-0417 to ${EXTERNAL}: deny. ${REASON_FILE}`);
    expect(lines).toContain(`[agent-2] 2c send LM-2026-0417 to ${EXTERNAL}: deny. ${REASON_MEMORY}`);
    expect(lines).toContain(`[agent-1] 2d send to ${INTERNAL}: allow`);
    expect(lines).toContain('[agent-1] list drive_list legal: allow');
    expect(lines.filter((l) => / read drive_read .*: allow$/.test(l))).toHaveLength(4);
  });

  it('stops after 2a and still ends both sessions when no matter reference was read', async () => {
    const { guard, events } = stubGuard(Object.fromEntries(LEGAL.map((n) => [n, 'SPECIMEN no reference here'])));
    const res = await runScript(DEFAULT_TASK, { guard, print: () => {} });
    expect(res.aborted).toMatch(/no matter reference/);
    expect(res.steps.map((s) => s.step)).toEqual(['list', 'read', 'read', 'read', 'read', '2a']);
    expect(events.slice(-2)).toEqual([{ op: 'end', session: 'agent-1' }, { op: 'end', session: 'agent-2' }]);
  });
});

describe('npm run agent', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'clearance-agent-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const config = () => loadConfig({ repoRoot: tmp, env: { GDRIVE_ROOT_FOLDER_ID: 'fake-root', APPA_PORT: '8790' } });

  it('runs the script on the Legal folder with the task text and exits 0', async () => {
    const drive = new FakeDriveClient();
    for (const n of LEGAL) await drive.upload(n, readFileSync(join(SEED, n), 'utf8'), 'legal');
    await drive.upload('05-invoice-0193.txt', 'x', 'accounting');
    const { guard, events } = stubGuard(seedContents());
    const urls: string[] = [];
    const lines: string[] = [];
    const code = await main(['check', 'the', 'legal', 'documents'], {
      config: config(),
      createDrive: async () => drive,
      makeGuard: (_cfg, _drive, url) => {
        urls.push(url);
        return { guard, close: async () => {} };
      },
      checkSidecar: async () => {},
      print: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(urls).toEqual(['http://127.0.0.1:8790']);
    expect(events[0]).toEqual({ op: 'start', session: 'agent-1', prompt: 'check the legal documents' });
    // The agent never lists Drive itself: the ids come from the guarded drive_list.
    expect(events[1]).toEqual({ op: 'call', session: 'agent-1', step: 'list', tool: 'drive_list', args: { folder: 'legal' } });
    const readIds = events.flatMap((e) => (e.op === 'call' && e.tool === 'drive_read' ? [(e.args as { fileId: string }).fileId] : []));
    expect(readIds).toEqual(LEGAL.map((n) => `id-${n}`));
    expect(drive.calls).toEqual([]);
    expect(lines[0]).toBe('[agent-1] task: check the legal documents');
  });

  it('exits 1 with a clear message when the sidecar is not up, without touching Drive', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createDrive = vi.fn();
    const code = await main([], {
      config: config(),
      createDrive,
      checkSidecar: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(code).toBe(1);
    expect(createDrive).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/Run `npm start`/));
    err.mockRestore();
  });
});
