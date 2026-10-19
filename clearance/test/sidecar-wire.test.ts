// Unit tests for the /hook wire, the remedy executor and the launcher, on responses recorded
// from a live runtime (test/fixtures/runtime/*.json, see sidecar-live.test.ts). No runtime here.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLEARANCE_DIR, loadConfig } from '../src/config';
import { CONTROL_TOOL, type RemedyCaller, RemedyError, executeRemedy, narrowingOfferId } from '../src/sidecar/remedy';
import { SidecarStartError, runtimeArgs, sidecarOptions, startSidecar } from '../src/sidecar/runtime';
import { type DenyCall, HookClient, WireError, parseDecision, rawToolName } from '../src/sidecar/wire';

interface Exchange {
  event: string;
  request: Record<string, unknown>;
  status: number;
  reply: Record<string, unknown>;
}
const fixture = <T = Exchange>(name: string): T =>
  JSON.parse(readFileSync(join(CLEARANCE_DIR, 'test', 'fixtures', 'runtime', `${name}.json`), 'utf8')) as T;
const replyText = (name: string) => JSON.stringify(fixture(name).reply);

/** A fetch that answers each POST from a queue and records the bodies it was sent. */
function scripted(replies: Array<{ status?: number; body: string } | Error>) {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = replies.shift();
    if (!next) throw new Error('no scripted reply left');
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status ?? 200 });
  };
  return { sent, fetchImpl };
}
const ok = (name: string) => ({ body: replyText(name) });

describe('parseDecision on recorded replies', () => {
  it('reads every recorded decision', () => {
    expect(parseDecision(200, replyText('session-start'))).toEqual({ decision: 'ack' });
    expect(parseDecision(200, replyText('drive-read-retry'))).toEqual({ decision: 'allow_call' });
    expect(parseDecision(200, replyText('remedy-control-call'))).toEqual({ decision: 'pass_control' });
    expect(parseDecision(200, replyText('drive-read-result'))).toEqual({ decision: 'ack' });
    const deny = parseDecision(200, replyText('send-counsel-deny')) as DenyCall;
    expect(deny.decision).toBe('deny_call');
    expect(deny.offers).toEqual([]);
    expect(deny.feedback).toMatch(/^\[appa\] Blocked: mcp__clearance__send cannot run yet\./);
  });

  it('reads the other decisions the wire defines', () => {
    const p = (o: object) => parseDecision(200, JSON.stringify({ protocol: 1, ...o }));
    expect(p({ decision: 'block', reason: 'r' })).toEqual({ decision: 'block', reason: 'r' });
    expect(p({ decision: 'replace_output', output: 'o' })).toEqual({ decision: 'replace_output', output: 'o' });
    expect(p({ decision: 'deliver_value', value: 'v' })).toEqual({ decision: 'deliver_value', value: 'v' });
    expect(p({ decision: 'context', text: 't' })).toEqual({ decision: 'context', text: 't' });
  });

  it('fails closed on refuse, non-JSON, malformed, wrong protocol, unknown decisions and HTTP errors', () => {
    const kind = (status: number, text: string) => {
      try {
        parseDecision(status, text);
      } catch (error) {
        return (error as WireError).kind;
      }
      return 'no error';
    };
    expect(kind(200, JSON.stringify({ protocol: 1, decision: 'refuse', class: 'malformed', detail: 'bad' }))).toBe('refuse');
    expect(kind(400, JSON.stringify({ protocol: 1, decision: 'refuse', class: 'malformed', detail: 'bad' }))).toBe('refuse');
    expect(kind(200, '<html>oops</html>')).toBe('non-json');
    expect(kind(200, '')).toBe('non-json');
    expect(kind(200, JSON.stringify({ protocol: 2, decision: 'ack' }))).toBe('malformed');
    expect(kind(200, JSON.stringify({ protocol: 1, decision: 'deny_call' }))).toBe('malformed');
    expect(kind(200, JSON.stringify({ protocol: 1, decision: 'deny_call', feedback: 'x', offers: [{}] }))).toBe('malformed');
    expect(kind(200, JSON.stringify({ protocol: 1, decision: 'child_return', value: 'v' }))).toBe('unexpected');
    expect(kind(500, JSON.stringify({ protocol: 1, decision: 'ack' }))).toBe('http');
  });
});

describe('narrowingOfferId', () => {
  const narrowing = parseDecision(200, replyText('drive-read-narrowing')) as DenyCall;

  it('finds the Accept offer on a narrowing deny', () => {
    expect(narrowing.offers).toHaveLength(1);
    expect(narrowingOfferId(narrowing)).toBe(narrowing.offers[0]?.offer_id);
  });

  it('finds none on a deny without offers, or on an offer that is not a plain narrowing', () => {
    expect(narrowingOfferId(parseDecision(200, replyText('send-counsel-deny')) as DenyCall)).toBeUndefined();
    expect(narrowingOfferId(parseDecision(200, replyText('drive-read-high-risk-deny')) as DenyCall)).toBeUndefined();
    const id = narrowing.offers[0]?.offer_id as string;
    expect(narrowingOfferId({ ...narrowing, offers: [{ offer_id: id, returns: 'void' }] })).toBeUndefined();
    expect(narrowingOfferId({ ...narrowing, offers: [{ offer_id: id }, { offer_id: 'ffffffffffffffff' }] })).toBeUndefined();
    expect(narrowingOfferId({ ...narrowing, feedback: '[appa] Blocked: needs sign-off' })).toBeUndefined();
  });
});

describe('HookClient', () => {
  it('posts the recorded request shapes and returns typed decisions', async () => {
    const { sent, fetchImpl } = scripted([ok('session-start'), ok('prompt'), ok('drive-read-narrowing'), ok('drive-read-retry'), ok('drive-read-result'), ok('turn-end')]);
    const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1/', fetch: fetchImpl });
    const root = 'live-agent-1';
    expect((await hook.sessionStart(root)).decision).toBe('ack');
    expect((await hook.prompt(root, 'go')).decision).toBe('ack');
    const call = { tool: rawToolName('drive_read'), arguments: { fileId: 'file-01', folder: 'legal' }, callId: 'c1' };
    expect((await hook.toolCall(root, call)).decision).toBe('deny_call');
    expect((await hook.toolCall(root, { ...call, callId: 'c2' })).decision).toBe('allow_call');
    expect((await hook.toolResult(root, { ...call, callId: 'c2' }, { status: 'success', body: { ok: 1 } })).decision).toBe('ack');
    expect((await hook.turnEnd(root)).decision).toBe('ack');

    const strip = ({ call_id: _c, ...rest }: Record<string, unknown>) => rest;
    expect(sent[0]).toEqual(fixture('session-start').request);
    expect(sent[1]).toEqual({ protocol: 1, adapter: 'amp', event: 'prompt', root_id: root, text: 'go' });
    expect(strip(sent[2] as Record<string, unknown>)).toEqual(strip(fixture('drive-read-narrowing').request));
    expect(sent[2]?.call_id).toBe('c1');
    expect(sent[4]).toMatchObject({ event: 'tool_result', call_id: 'c2', outcome: { status: 'success', body: { ok: 1 } } });
    expect(sent[5]).toEqual(fixture('turn-end').request);
  });

  it('throws on a decision the event may not get', async () => {
    const { fetchImpl } = scripted([ok('drive-read-retry'), ok('session-start')]);
    const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl });
    await expect(hook.sessionStart('r')).rejects.toMatchObject({ kind: 'unexpected' });
    await expect(hook.toolCall('r', { tool: 't', arguments: {}, callId: 'c' })).rejects.toMatchObject({ kind: 'unexpected' });
  });

  it('fails closed on a refuse, a transport error, and a timeout', async () => {
    const refuse = { body: JSON.stringify({ protocol: 1, decision: 'refuse', class: 'malformed', detail: 'tool is outside the domain' }) };
    const { fetchImpl } = scripted([refuse, new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:8790')]);
    const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl });
    const call = { tool: 'x', arguments: {}, callId: 'c' };
    const refused = await hook.toolCall('r', call).catch((e: unknown) => e as WireError);
    expect(refused).toBeInstanceOf(WireError);
    expect(refused).toMatchObject({ kind: 'refuse', message: '[appa] tool is outside the domain' });
    const down = (await hook.toolCall('r', call).catch((e: unknown) => e)) as WireError;
    expect(down).toMatchObject({ kind: 'transport' });
    expect(down.message).not.toContain('ECONNREFUSED');

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const slow = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: hanging, timeoutMs: 50 });
    await expect(slow.toolCall('r', call)).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('executeRemedy', () => {
  const offerId = (fixture('drive-read-narrowing').reply.offers as Array<{ offer_id: string }>)[0]?.offer_id as string;
  const mcpReply = fixture<{ reply: string }>('remedy-mcp-reply').reply;
  const caller = (reply: { text: string; isError: boolean } | Error, calls: string[] = []): RemedyCaller => ({
    async callRemedy(id) {
      calls.push(id);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async close() {},
  });

  it('posts tool_call (pass_control), calls MCP, then posts tool_result (ack)', async () => {
    const { sent, fetchImpl } = scripted([ok('remedy-control-call'), ok('remedy-control-result')]);
    const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl });
    const calls: string[] = [];
    const run = await executeRemedy(hook, caller({ text: mcpReply, isError: false }, calls), 'live-agent-1', offerId);
    expect(calls).toEqual([offerId]);
    expect(run.reply).toBe(mcpReply);
    const strip = ({ call_id: _c, ...rest }: Record<string, unknown>) => rest;
    expect(strip(sent[0] as Record<string, unknown>)).toEqual(strip(fixture('remedy-control-call').request));
    expect(strip(sent[1] as Record<string, unknown>)).toEqual(strip(fixture('remedy-control-result').request));
    expect(sent[0]?.tool).toBe(CONTROL_TOOL);
    expect(sent[0]?.call_id).toBe(sent[1]?.call_id);
  });

  it('fails closed when the control call is not passed', async () => {
    const { fetchImpl } = scripted([ok('send-counsel-deny')]);
    const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl });
    const calls: string[] = [];
    await expect(executeRemedy(hook, caller({ text: mcpReply, isError: false }, calls), 'r', offerId)).rejects.toBeInstanceOf(RemedyError);
    expect(calls).toEqual([]);
  });

  it('settles the control call as a failure and throws when MCP refuses or breaks', async () => {
    for (const reply of [{ text: '[appa] no such offer', isError: true }, new RemedyError('runtime /mcp unreachable')]) {
      const { sent, fetchImpl } = scripted([ok('remedy-control-call'), ok('remedy-control-result')]);
      const hook = new HookClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchImpl });
      await expect(executeRemedy(hook, caller(reply), 'r', offerId)).rejects.toBeInstanceOf(RemedyError);
      expect(sent[1]).toMatchObject({ event: 'tool_result', tool: CONTROL_TOOL, outcome: { status: 'failure' } });
    }
  });
});

describe('launcher', () => {
  let dir: string;
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const opts = (bin: string, startTimeoutMs = 5000) => ({ bin, config: 'appa.toml', db: join(dir, 'state', 'appa.db'), port: 0, startTimeoutMs });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'clearance-launcher-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs appa runtime under the amp adapter on loopback with the config and db', () => {
    expect(runtimeArgs({ config: '/c/appa.toml', db: '/s/appa.db', port: 8790 })).toEqual([
      'runtime', '--adapter', 'amp', '--listen', '127.0.0.1:8790', '--config', '/c/appa.toml', '--db', '/s/appa.db',
    ]);
  });

  it('takes its production options from config', () => {
    const cfg = loadConfig({ repoRoot: dir, env: { APPA_BIN: '/opt/appa', APPA_PORT: '8790' } });
    expect(sidecarOptions(cfg)).toEqual({
      bin: '/opt/appa',
      config: join(dir, 'clearance', 'appa.toml'),
      db: join(dir, 'clearance', 'state', 'appa.db'),
      port: 8790,
    });
  });

  it('waits for /health, then stops cleanly', async () => {
    const fake = script(
      'fake-ok.mjs',
      `import http from 'node:http';
       const s = http.createServer((q, r) => { r.statusCode = q.url === '/health' ? 200 : 404; r.end('ok'); });
       s.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + s.address().port));
       process.on('SIGTERM', () => s.close(() => process.exit(0)));`,
    );
    const sidecar = await startSidecar(opts(fake));
    expect(sidecar.running()).toBe(true);
    expect((await fetch(`${sidecar.url}/health`)).ok).toBe(true);
    await sidecar.stop();
    expect(sidecar.running()).toBe(false);
    await sidecar.stop();
  });

  it('rejects when the binary is missing, exits early, or never gets healthy', async () => {
    await expect(startSidecar(opts(join(dir, 'no-such-appa')))).rejects.toBeInstanceOf(SidecarStartError);
    const dies = script('fake-dies.mjs', `console.error('config refused'); process.exit(3);`);
    await expect(startSidecar(opts(dies))).rejects.toThrow(/exited[\s\S]*config refused/);
    const sick = script(
      'fake-sick.mjs',
      `import http from 'node:http';
       const s = http.createServer((q, r) => { r.statusCode = 503; r.end(); });
       s.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + s.address().port));`,
    );
    await expect(startSidecar(opts(sick, 600))).rejects.toThrow(/did not answer/);
    const remote = script('fake-remote.mjs', `console.log('http://10.0.0.1:8790'); setInterval(() => {}, 1000);`);
    await expect(startSidecar(opts(remote))).rejects.toThrow(/unexpected first line/);
  }, 20_000);
});
