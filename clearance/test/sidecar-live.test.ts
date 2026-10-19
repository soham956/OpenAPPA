// Live test against the real `appa runtime --adapter amp` with clearance/appa.toml and a temp DB.
// Skipped only when APPA_BIN is absent AND CLEARANCE_REQUIRE_APPA is unset.
// CLEARANCE_RECORD_FIXTURES=1 rewrites test/fixtures/runtime/*.json from this run.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLEARANCE_DIR } from '../src/config';
import { CONTROL_TOOL, McpRemedyClient, executeRemedy, narrowingOfferId } from '../src/sidecar/remedy';
import { type Sidecar, startSidecar } from '../src/sidecar/runtime';
import { HookClient, type WireCall, WireError, newCallId, rawToolName } from '../src/sidecar/wire';

const truthy = (v: string | undefined) => ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());
const APPA_BIN = process.env.APPA_BIN?.trim();
const REQUIRED = truthy(process.env.CLEARANCE_REQUIRE_APPA);
const RECORD = truthy(process.env.CLEARANCE_RECORD_FIXTURES);
const FIXTURES = join(CLEARANCE_DIR, 'test', 'fixtures', 'runtime');

interface Exchange {
  event: string;
  request: unknown;
  status: number;
  reply: unknown;
}

describe.skipIf(!APPA_BIN && !REQUIRED)('appa sidecar (live)', () => {
  let dir: string;
  let sidecar: Sidecar;
  let hook: HookClient;
  let mcp: McpRemedyClient;
  const exchanges: Exchange[] = [];
  const recorded = new Map<string, Exchange | { reply: string }>();
  const record = (name: string) => {
    const last = exchanges.at(-1);
    if (!last) throw new Error('nothing to record');
    recorded.set(name, last);
  };

  // Records every raw /hook request and reply, so the fixtures are byte-faithful.
  const recordingFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const text = await response.text();
    const request = JSON.parse(String(init?.body ?? 'null')) as { event: string };
    exchanges.push({ event: request.event, request, status: response.status, reply: JSON.parse(text) });
    return new Response(text, { status: response.status, headers: response.headers });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clearance-sidecar-'));
    sidecar = await startSidecar({
      bin: APPA_BIN || 'appa',
      config: join(CLEARANCE_DIR, 'appa.toml'),
      db: join(dir, 'state', 'appa.db'),
      port: 0,
    });
    hook = new HookClient({ baseUrl: sidecar.url, fetch: recordingFetch });
    mcp = new McpRemedyClient(sidecar.url);
  }, 30_000);

  afterAll(async () => {
    await mcp?.close();
    await sidecar?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (RECORD && recorded.size > 0) {
      mkdirSync(FIXTURES, { recursive: true });
      for (const [name, value] of recorded) {
        writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
      }
    }
  });

  it('serves /health on loopback', async () => {
    expect(sidecar.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sidecar.running()).toBe(true);
    const res = await fetch(`${sidecar.url}/health`);
    expect(res.ok).toBe(true);
  });

  it('narrows a Legal read, runs the remedy, allows the retry, and denies a send to counsel', async () => {
    const root = 'live-agent-1';
    const started = await hook.sessionStart(root);
    record('session-start');
    expect(['ack', 'context']).toContain(started.decision);
    expect((await hook.prompt(root, 'check the legal documents and send them to the legal team')).decision).toBe('ack');
    record('prompt');

    // 1. A Legal read gets deny_call with an Accept offer.
    const readArgs = { fileId: 'file-01', folder: 'legal' };
    const first: WireCall = { tool: rawToolName('drive_read'), arguments: readArgs, callId: newCallId() };
    const denied = await hook.toolCall(root, first);
    record('drive-read-narrowing');
    expect(denied.decision).toBe('deny_call');
    if (denied.decision !== 'deny_call') return;
    expect(denied.feedback.startsWith('[appa] ')).toBe(true);
    expect(denied.offers).toHaveLength(1);
    const offerId = narrowingOfferId(denied);
    expect(offerId).toBe(denied.offers[0]?.offer_id);

    // 2. The remedy: tool_call (pass_control) -> MCP execute_remedy_plan -> tool_result (ack).
    const run = await executeRemedy(hook, mcp, root, offerId as string);
    const [controlCall, controlResult] = exchanges.slice(-2);
    recorded.set('remedy-control-call', controlCall as Exchange);
    recorded.set('remedy-control-result', controlResult as Exchange);
    recorded.set('remedy-mcp-reply', { reply: run.reply });
    expect((controlCall?.reply as { decision: string }).decision).toBe('pass_control');
    expect((controlCall?.request as { tool: string }).tool).toBe(CONTROL_TOOL);
    expect((controlResult?.reply as { decision: string }).decision).toBe('ack');

    // 3. The retry gets allow_call, then ack for its result.
    const retry: WireCall = { ...first, callId: newCallId() };
    const allowed = await hook.toolCall(root, retry);
    record('drive-read-retry');
    expect(allowed.decision).toBe('allow_call');
    const settled = await hook.toolResult(root, retry, {
      status: 'success',
      body: { name: '01-mutual-nda-kestrel-orbit.txt', content: 'SPECIMEN Matter Ref: LM-2026-0417', folder: 'legal' },
    });
    record('drive-read-result');
    expect(settled.decision).toBe('ack');

    // A second read with the same audience needs no narrowing.
    const again: WireCall = { tool: rawToolName('drive_read'), arguments: { fileId: 'file-02', folder: 'legal' }, callId: newCallId() };
    expect((await hook.toolCall(root, again)).decision).toBe('allow_call');
    record('drive-read-second');
    expect((await hook.toolResult(root, again, { status: 'success', body: { name: '02', content: 'x', folder: 'legal' } })).decision).toBe('ack');

    // 4. A send to counsel gets deny_call with no offers.
    const send: WireCall = {
      tool: rawToolName('send'),
      arguments: { to: ['counsel@outside-firm.test'], subject: 'Matter reference', body: 'LM-2026-0417' },
      callId: newCallId(),
    };
    const blocked = await hook.toolCall(root, send);
    record('send-counsel-deny');
    expect(blocked.decision).toBe('deny_call');
    if (blocked.decision === 'deny_call') {
      expect(blocked.offers).toEqual([]);
      expect(narrowingOfferId(blocked)).toBeUndefined();
    }

    // 2d: a send to legal@ only is allowed.
    const legal: WireCall = {
      tool: rawToolName('send'),
      arguments: { to: ['legal@hashirai-poc.test'], subject: 'Legal documents for review', attachments: ['01-mutual-nda-kestrel-orbit.txt'] },
      callId: newCallId(),
    };
    expect((await hook.toolCall(root, legal)).decision).toBe('allow_call');
    record('send-legal-allow');
    expect((await hook.toolResult(root, legal, { status: 'success', body: { ok: true } })).decision).toBe('ack');

    expect((await hook.turnEnd(root)).decision).toBe('ack');
    record('turn-end');
  });

  it('denies a High Risk read and a root read with no offers', async () => {
    const root = 'live-agent-hold';
    await hook.sessionStart(root);
    const hold = await hook.toolCall(root, {
      tool: rawToolName('drive_read'),
      arguments: { fileId: 'file-08', folder: 'high-risk' },
      callId: newCallId(),
    });
    record('drive-read-high-risk-deny');
    expect(hold.decision).toBe('deny_call');
    if (hold.decision === 'deny_call') expect(hold.offers).toEqual([]);

    const rootRead = await hook.toolCall(root, {
      tool: rawToolName('drive_read'),
      arguments: { fileId: 'file-11', folder: 'root' },
      callId: newCallId(),
    });
    record('drive-read-root-deny');
    expect(rootRead.decision).toBe('deny_call');
    if (rootRead.decision === 'deny_call') expect(rootRead.offers).toEqual([]);
  });

  it('a remedy for an unknown offer fails closed', async () => {
    const root = 'live-agent-bad-offer';
    await hook.sessionStart(root);
    await expect(executeRemedy(hook, mcp, root, '0000000000000000')).rejects.toThrow();
  });

  it('fails closed once the runtime is stopped', async () => {
    await sidecar.stop();
    expect(sidecar.running()).toBe(false);
    const err = await hook.sessionStart('live-agent-after-stop').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WireError);
    expect((err as WireError).kind).toBe('transport');
  });
});
