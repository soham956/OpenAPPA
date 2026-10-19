// Guard tests. The scenarios run twice:
//  - live, against the real `appa runtime` (skipped only when APPA_BIN is absent and
//    CLEARANCE_REQUIRE_APPA is unset); CLEARANCE_RECORD_FIXTURES=1 records every /hook
//    exchange and MCP reply to test/fixtures/runtime/guard/*.json;
//  - replayed, from those fixtures, with every request the guard sends checked against the
//    recorded one (call ids aside).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLEARANCE_DIR } from '../src/config';
import { FakeDriveClient } from '../src/drive/fake';
import { DecisionLog } from '../src/log/decision-log';
import type { EnforceLine } from '../src/log/schema';
import { memoryLoad, memorySave } from '../src/tools/memory';
import { send } from '../src/tools/send';
import { Guard, type GuardResult, type GuardTools } from '../src/sidecar/guard';
import { McpRemedyClient, type RemedyCaller } from '../src/sidecar/remedy';
import { type Sidecar, startSidecar } from '../src/sidecar/runtime';
import { HookClient } from '../src/sidecar/wire';

const truthy = (v: string | undefined) => ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());
const APPA_BIN = process.env.APPA_BIN?.trim();
const LIVE = Boolean(APPA_BIN) || truthy(process.env.CLEARANCE_REQUIRE_APPA);
const RECORD = truthy(process.env.CLEARANCE_RECORD_FIXTURES);
const FIXTURES = join(CLEARANCE_DIR, 'test', 'fixtures', 'runtime', 'guard');

const PROMPT = 'check the legal documents and send them to the legal team';
const LEGAL = 'legal@hashirai-poc.test';
const COUNSEL = 'counsel@outside-firm.test';
const MATTER = 'LM-2026-0417';
const REASON_FILE = `Blocked: Legal content may only go to ${LEGAL}. ${COUNSEL} is outside that list.`;
const REASON_MEMORY = `Blocked: this memory entry came from Legal content, which may only go to ${LEGAL}. ${COUNSEL} is outside that list.`;
const LEGAL_FILES = [
  '01-mutual-nda-kestrel-orbit.txt',
  '02-master-services-agreement.txt',
  '03-cease-and-desist-letter.txt',
  '04-board-resolution-oct.txt',
];

// ---- shared scenario setup --------------------------------------------------------------

interface World {
  dir: string;
  drive: FakeDriveClient;
  ids: Record<string, string>;
  log: DecisionLog;
  outbox: string;
  memory: string;
  tools: { [K in keyof GuardTools]: ReturnType<typeof vi.fn<GuardTools[K]>> };
}

/** A fake Drive laid out as after step 1 (ids are deterministic), plus temp logs and spies. */
async function world(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'clearance-guard-'));
  const drive = new FakeDriveClient();
  await drive.ensureSubfolders();
  const ids: Record<string, string> = {};
  for (const name of LEGAL_FILES) {
    ids[name] = (await drive.upload(name, readFileSync(join(CLEARANCE_DIR, 'seed', name), 'utf8'), 'legal')).id;
  }
  ids['08'] = (await drive.upload('08-employment-contract-r-okafor.txt', 'SPECIMEN SPC-4417-2290', 'high-risk')).id;
  ids['11'] = (await drive.upload('11-vendor-invoice-0207.txt', 'SPECIMEN invoice', 'root')).id;
  const outbox = join(dir, 'outbox.jsonl');
  const memory = join(dir, 'memory.json');
  const tools = {
    drive_list: vi.fn<GuardTools['drive_list']>(async (args, ctx) => (await ctx.drive.list(args.folder)).map((f) => ({ id: f.id, name: f.name }))),
    drive_read: vi.fn<GuardTools['drive_read']>(async (args, ctx) => {
      const f = await ctx.drive.read(args.fileId);
      return { name: f.name, content: f.content, folder: args.folder };
    }),
    send: vi.fn<GuardTools['send']>(async (args, ctx) => {
      const line = send(args, { session: ctx.session, outboxPath: outbox });
      return { to: line.to, subject: line.subject, attachments: line.attachments };
    }),
    memory_save: vi.fn<GuardTools['memory_save']>(async (args, ctx) => memorySave(args, { origin: ctx.session, memoryPath: memory })),
    memory_load: vi.fn<GuardTools['memory_load']>(async (args) => memoryLoad(args, { memoryPath: memory })),
  };
  const log = new DecisionLog({ path: join(dir, 'decisions.jsonl'), now: () => new Date('2026-10-19T00:00:00Z') });
  return { dir, drive, ids, log, outbox, memory, tools };
}

function guardFor(w: World, hook: HookClient, remedy: RemedyCaller, prefix: string): Guard {
  return new Guard({ hook, remedy, drive: w.drive, log: w.log, tools: w.tools, rootOf: (s) => `${prefix}${s}` });
}

const readJsonl = (path: string) =>
  existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];

type Results = Record<string, GuardResult>;

/** Demo step 2, exactly as the scripted agent will run it. */
async function runDemo(guard: Guard, w: World): Promise<Results> {
  const r: Results = {};
  await guard.start('agent-1', PROMPT);
  r.list = await guard.call('agent-1', 'list', 'drive_list', { folder: 'legal' });
  for (const name of LEGAL_FILES) {
    r[name] = await guard.call('agent-1', 'read', 'drive_read', { fileId: w.ids[name] as string });
  }
  const docs = { subject: 'Legal documents for review', attachments: LEGAL_FILES };
  r['2a'] = await guard.call('agent-1', '2a', 'send', { to: [LEGAL, COUNSEL], ...docs });
  r['2b'] = await guard.call('agent-1', '2b', 'send', { to: [COUNSEL], subject: 'Matter reference', body: MATTER });
  r['2c-save'] = await guard.call('agent-1', '2c-save', 'memory_save', { scope: 'legal-handoff', value: MATTER });
  await guard.start('agent-2', 'load the legal handoff and send it to outside counsel');
  r['2c-load'] = await guard.call('agent-2', '2c-load', 'memory_load', { scope: 'legal-handoff' });
  r['2c'] = await guard.call('agent-2', '2c', 'send', { to: [COUNSEL], subject: 'Matter reference', body: MATTER });
  r['2d'] = await guard.call('agent-1', '2d', 'send', { to: [LEGAL], ...docs });
  await guard.end('agent-2');
  await guard.end('agent-1');
  return r;
}

/** The High Risk hold and an unclassified read. The agent lies about the folder. */
async function runHold(guard: Guard, w: World): Promise<Results> {
  const r: Results = {};
  await guard.start('agent-1', PROMPT);
  r.held = await guard.call('agent-1', 'read', 'drive_read', { fileId: w.ids['08'] as string, folder: 'legal' });
  r.root = await guard.call('agent-1', 'read', 'drive_read', { fileId: w.ids['11'] as string, folder: 'legal' });
  await w.drive.move(w.ids['08'] as string, 'legal'); // a person releases the file in Drive
  r.released = await guard.call('agent-1', 'read', 'drive_read', { fileId: w.ids['08'] as string, folder: 'high-risk' });
  return r;
}

/** A Legal read, then a send whose membership read fails (the rcpt source is broken). */
async function runSourceFailure(guard: Guard, w: World): Promise<Results> {
  const r: Results = {};
  await guard.start('agent-1', PROMPT);
  r.read = await guard.call('agent-1', 'read', 'drive_read', { fileId: w.ids[LEGAL_FILES[0] as string] as string });
  r.send = await guard.call('agent-1', '2d', 'send', { to: [LEGAL], subject: 'Legal documents for review' });
  return r;
}

// ---- assertions shared by the live and replayed runs -----------------------------------

function checkDemo(r: Results, w: World) {
  const decisions = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.decision]));
  expect(decisions).toEqual({
    list: 'allow',
    [LEGAL_FILES[0] as string]: 'allow',
    [LEGAL_FILES[1] as string]: 'allow',
    [LEGAL_FILES[2] as string]: 'allow',
    [LEGAL_FILES[3] as string]: 'allow',
    '2a': 'deny',
    '2b': 'deny',
    '2c-save': 'allow',
    '2c-load': 'allow',
    '2c': 'deny',
    '2d': 'allow',
  });
  expect((r['2a'] as { reason: string }).reason).toBe(REASON_FILE);
  expect((r['2b'] as { reason: string }).reason).toBe(REASON_FILE);
  expect((r['2c'] as { reason: string }).reason).toBe(REASON_MEMORY);
  expect((r['2c-load'] as { result: unknown }).result).toEqual({ value: MATTER, origin: 'agent-1' });

  // Denied sends never reached the tool; the one allowed send wrote the one outbox line.
  expect(w.tools.send).toHaveBeenCalledTimes(1);
  expect(readJsonl(w.outbox)).toEqual([{ to: [LEGAL], subject: 'Legal documents for review', attachments: LEGAL_FILES, session: 'agent-1' }]);
  expect(w.tools.drive_read).toHaveBeenCalledTimes(4);

  // One enforce line per attempt, with the caller's step as given.
  const lines = w.log.readEnforce().map(({ ts: _ts, offerId, ...rest }) => ({ ...rest, offer: offerId !== undefined }));
  expect(lines).toEqual([
    { kind: 'enforce', step: 'list', session: 'agent-1', tool: 'drive_list', decision: 'allow', offer: false },
    ...LEGAL_FILES.map((file, i) => ({ kind: 'enforce', step: 'read', session: 'agent-1', tool: 'drive_read', file, decision: 'allow', offer: i === 0 })),
    { kind: 'enforce', step: '2a', session: 'agent-1', tool: 'send', to: [LEGAL, COUNSEL], decision: 'deny', reason: REASON_FILE, offer: false },
    { kind: 'enforce', step: '2b', session: 'agent-1', tool: 'send', to: [COUNSEL], decision: 'deny', reason: REASON_FILE, offer: false },
    { kind: 'enforce', step: '2c-save', session: 'agent-1', tool: 'memory_save', scope: 'legal-handoff', decision: 'allow', offer: false },
    { kind: 'enforce', step: '2c-load', session: 'agent-2', tool: 'memory_load', scope: 'legal-handoff', decision: 'allow', offer: true },
    { kind: 'enforce', step: '2c', session: 'agent-2', tool: 'send', to: [COUNSEL], decision: 'deny', reason: REASON_MEMORY, offer: false },
    { kind: 'enforce', step: '2d', session: 'agent-1', tool: 'send', to: [LEGAL], decision: 'allow', offer: false },
  ]);
}

function checkHold(r: Results, w: World) {
  expect(r.held?.decision).toBe('deny');
  expect(r.root?.decision).toBe('deny');
  expect(r.released?.decision).toBe('allow');
  // Unknown denies pass the runtime's text through.
  expect((r.held as { reason: string }).reason).toMatch(/^\[appa\] Blocked: mcp__clearance__drive_read cannot run yet\.[\s\S]*requires attention: blocked$/);
  expect((r.root as { reason: string }).reason).toBe('[appa] invalid call: invalid call: arguments match no registered contract');
  // Only the released read ran the tool, with the folder Drive reported.
  expect(w.tools.drive_read).toHaveBeenCalledTimes(1);
  expect(w.tools.drive_read.mock.calls[0]?.[0]).toEqual({ fileId: w.ids['08'], folder: 'legal' });
  expect(w.log.readEnforce().map((l) => [l.file, l.decision])).toEqual([
    ['08-employment-contract-r-okafor.txt', 'deny'],
    ['11-vendor-invoice-0207.txt', 'deny'],
    ['08-employment-contract-r-okafor.txt', 'allow'],
  ]);
}

function checkSourceFailure(r: Results, w: World) {
  expect(r.read?.decision).toBe('allow');
  expect(r.send?.decision).toBe('error');
  expect((r.send as { reason: string }).reason).toMatch(/audience source rcpt gave no answer/);
  expect(w.tools.send).not.toHaveBeenCalled();
  expect(w.log.readEnforce().at(-1)).toMatchObject({ step: '2d', tool: 'send', decision: 'error' });
}

// ---- recording and replay ---------------------------------------------------------------

interface Exchange {
  request: Record<string, unknown>;
  status: number;
  reply: unknown;
}
interface Fixture {
  exchanges: Exchange[];
  mcp: string[];
}

const withoutCallId = ({ call_id: _c, ...rest }: Record<string, unknown>) => rest;

function recorder(hookUrl: string, remedy: RemedyCaller) {
  const fixture: Fixture = { exchanges: [], mcp: [] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.text();
    fixture.exchanges.push({ request: JSON.parse(String(init?.body)) as Record<string, unknown>, status: response.status, reply: JSON.parse(text) });
    return new Response(text, { status: response.status });
  };
  const recordingRemedy: RemedyCaller = {
    async callRemedy(offerId) {
      const reply = await remedy.callRemedy(offerId);
      fixture.mcp.push(reply.text);
      return reply;
    },
    close: () => remedy.close(),
  };
  return { fixture, hook: new HookClient({ baseUrl: hookUrl, fetch: fetchImpl }), remedy: recordingRemedy };
}

function replayer(fixture: Fixture) {
  let i = 0;
  let j = 0;
  const mismatches: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const want = fixture.exchanges[i++];
    if (!want || JSON.stringify(withoutCallId(sent)) !== JSON.stringify(withoutCallId(want.request))) {
      mismatches.push(`request ${i}: sent ${JSON.stringify(sent)}, recorded ${JSON.stringify(want?.request)}`);
      throw new Error('replay mismatch');
    }
    return new Response(JSON.stringify(want.reply), { status: want.status });
  };
  const remedy: RemedyCaller = {
    async callRemedy() {
      const text = fixture.mcp[j++];
      if (text === undefined) throw new Error('no recorded MCP reply left');
      return { text, isError: false };
    },
    async close() {},
  };
  return {
    hook: new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl }),
    remedy,
    done() {
      expect(mismatches).toEqual([]);
      expect(i).toBe(fixture.exchanges.length);
      expect(j).toBe(fixture.mcp.length);
    },
  };
}

const loadFixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;

const SCENARIOS = [
  { name: 'demo', run: runDemo, check: checkDemo },
  { name: 'hold', run: runHold, check: checkHold },
  { name: 'source-failure', run: runSourceFailure, check: checkSourceFailure },
] as const;

// ---- replayed from fixtures --------------------------------------------------------------

describe('guard on recorded runtime responses', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  for (const scenario of SCENARIOS) {
    it(`replays the ${scenario.name} scenario`, async () => {
      const replay = replayer(loadFixture(scenario.name));
      const results = await scenario.run(guardFor(w, replay.hook, replay.remedy, `${scenario.name}-`), w);
      replay.done();
      scenario.check(results, w);
    });
  }

  it('overwrites an agent-supplied folder with the folder Drive reports', async () => {
    const fixture = loadFixture('hold');
    const sent = fixture.exchanges.filter((e) => e.request.event === 'tool_call' && e.request.tool === 'mcp__clearance__drive_read');
    // The agent said `legal`, `legal`, `high-risk`; Drive said `high-risk`, `root`, then `legal`.
    expect(sent.map((e) => (e.request.arguments as { folder: string }).folder).slice(0, 3)).toEqual(['high-risk', 'root', 'legal']);
  });

  it('accepts a narrowing only for drive_read and memory_load', async () => {
    const narrowing = loadFixture('demo').exchanges.find(
      (e) => (e.reply as { decision?: string; offers?: unknown[] }).decision === 'deny_call' && ((e.reply as { offers: unknown[] }).offers ?? []).length === 1,
    );
    expect(narrowing).toBeDefined();
    const answers = [{ protocol: 1, decision: 'ack' }, { protocol: 1, decision: 'ack' }, narrowing?.reply];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(answers.shift()));
    const remedy = { callRemedy: vi.fn(), close: async () => {} };
    const guard = guardFor(w, new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl }), remedy, 'x-');
    const result = await guard.call('agent-1', '2d', 'send', { to: [LEGAL], subject: 's' });
    expect(result.decision).toBe('deny');
    expect(remedy.callRemedy).not.toHaveBeenCalled();
    expect(w.tools.send).not.toHaveBeenCalled();
  });

  it('refuses the call and logs error on a runtime error, a refuse, or a remedy failure', async () => {
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const remedy = { callRemedy: vi.fn(), close: async () => {} };
    const a = await guardFor(w, new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: down }), remedy, 'x-').call('agent-1', '2d', 'send', {
      to: [LEGAL],
      subject: 's',
    });
    expect(a).toMatchObject({ decision: 'error', reason: '[guard] runtime unreachable for session_start' });

    const refuse = { protocol: 1, decision: 'refuse', class: 'malformed', detail: 'the call is malformed' };
    const replies = [{ protocol: 1, decision: 'ack' }, { protocol: 1, decision: 'ack' }, refuse];
    const refusing: typeof fetch = async () => new Response(JSON.stringify(replies.shift()));
    const b = await guardFor(w, new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: refusing }), remedy, 'y-').call('agent-1', 'read', 'drive_read', {
      fileId: w.ids['08'] as string,
    });
    expect(b).toMatchObject({ decision: 'error', reason: '[appa] the call is malformed' });

    const narrowing = loadFixture('demo').exchanges.find((e) => ((e.reply as { offers?: unknown[] }).offers ?? []).length === 1)?.reply;
    const replies2 = [{ protocol: 1, decision: 'ack' }, { protocol: 1, decision: 'ack' }, narrowing, { protocol: 1, decision: 'ack' }];
    const passing: typeof fetch = async (_i, init) => {
      const body = JSON.parse(String(init?.body)) as { event: string; tool?: string };
      if (body.event === 'tool_call' && body.tool === 'mcp__appa__execute_remedy_plan') return new Response(JSON.stringify({ protocol: 1, decision: 'pass_control' }));
      return new Response(JSON.stringify(replies2.shift()));
    };
    const broken = { callRemedy: vi.fn(async () => ({ text: '[appa] the offer expired', isError: true })), close: async () => {} };
    const c = await guardFor(w, new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: passing }), broken, 'z-').call('agent-1', 'read', 'drive_read', {
      fileId: w.ids[LEGAL_FILES[0] as string] as string,
    });
    expect(c.decision).toBe('error');
    expect(broken.callRemedy).toHaveBeenCalledTimes(1);

    expect(w.tools.send).not.toHaveBeenCalled();
    expect(w.tools.drive_read).not.toHaveBeenCalled();
    expect(w.log.readEnforce().map((l: EnforceLine) => l.decision)).toEqual(['error', 'error', 'error']);
  });

  it('logs drive_list with the step the caller passes (list)', async () => {
    const replies = [{ protocol: 1, decision: 'ack' }, { protocol: 1, decision: 'ack' }, { protocol: 1, decision: 'allow_call' }, { protocol: 1, decision: 'ack' }];
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(replies.shift()));
    const guard = guardFor(w, new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl }), { callRemedy: vi.fn(), close: async () => {} }, 'x-');
    const r = await guard.call('agent-1', 'list', 'drive_list', { folder: 'legal' });
    expect(r.decision).toBe('allow');
    expect((r as { result: unknown }).result).toHaveLength(4);
    expect(w.log.readEnforce()[0]).toMatchObject({ step: 'list', tool: 'drive_list', decision: 'allow' });
  });
});

// ---- live, against the real runtime ------------------------------------------------------

describe.skipIf(!LIVE)('guard against the live runtime', () => {
  const sidecars: Sidecar[] = [];
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clearance-guard-live-'));
  });
  afterAll(async () => {
    await Promise.all(sidecars.map((s) => s.stop()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function sidecar(config: string, name: string): Promise<Sidecar> {
    const s = await startSidecar({ bin: APPA_BIN || 'appa', config, db: join(dir, name, 'appa.db'), port: 0 });
    sidecars.push(s);
    return s;
  }

  /** clearance/appa.toml with the rcpt source swapped for one that always fails. */
  function brokenConfig(): string {
    const text = readFileSync(join(CLEARANCE_DIR, 'appa.toml'), 'utf8');
    const broken = text.replace('command = ["node", "./policy/rcpt-audience.mjs"]', 'command = ["node", "-e", "process.exit(1)"]');
    expect(broken).not.toBe(text);
    const path = join(dir, 'broken', 'appa.toml');
    mkdirSync(join(dir, 'broken'), { recursive: true });
    writeFileSync(path, broken);
    return path;
  }

  for (const scenario of SCENARIOS) {
    it(`runs the ${scenario.name} scenario`, async () => {
      const config = scenario.name === 'source-failure' ? brokenConfig() : join(CLEARANCE_DIR, 'appa.toml');
      const s = await sidecar(config, scenario.name);
      const w = await world();
      const mcp = new McpRemedyClient(s.url);
      try {
        const rec = recorder(s.url, mcp);
        const results = await scenario.run(guardFor(w, rec.hook, rec.remedy, `${scenario.name}-`), w);
        scenario.check(results, w);
        if (RECORD) {
          mkdirSync(FIXTURES, { recursive: true });
          writeFileSync(join(FIXTURES, `${scenario.name}.json`), `${JSON.stringify(rec.fixture, null, 2)}\n`);
        }
      } finally {
        await mcp.close();
        rmSync(w.dir, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
