// GoogleDriveClient against a stubbed drive_v3 files API: no network. These
// check the request shapes (scoping, supportsAllDrives, pagination); the
// behaviour shared with the fake is in drive-contract.test.ts.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { google } from 'googleapis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { FakeDriveFilesApi, type StubBehavior, type StubCall } from '../src/drive/fake';
import { createDriveClient } from '../src/drive/factory';
import {
  DEFAULT_TIMEOUT_MS,
  DriveRequestError,
  GoogleDriveClient,
  isRetryable,
  q,
} from '../src/drive/google';
import { DriveScopeError, FOLDER_MIME } from '../src/drive/types';

const ROOT = 'root-folder-id';

function setup() {
  const files = new FakeDriveFilesApi();
  const client = new GoogleDriveClient({ files }, ROOT);
  return { files, client };
}

/** Drive ids in the tree: the root plus whichever subfolders exist. */
function treeIds(files: FakeDriveFilesApi): Set<string> {
  const ids = new Set([ROOT]);
  for (const i of files.items.values()) if (i.parents.includes(ROOT) && i.mimeType === FOLDER_MIME) ids.add(i.id);
  return ids;
}

function parentsInQuery(qs: string): string[] {
  return [...qs.matchAll(/'((?:[^'\\]|\\.)*)' in parents/g)].map((m) => m[1]!);
}

async function exercise(files: FakeDriveFilesApi, client: GoogleDriveClient) {
  const outsideFolder = files.add({ name: 'Elsewhere', mimeType: FOLDER_MIME, parents: ['my-drive'] });
  const outside = files.add({ name: 'payroll.txt', content: 'x', parents: [outsideFolder] });
  await client.ensureSubfolders();
  await client.ensureSubfolders();
  const a = await client.upload('01-a.txt', 'SPECIMEN a');
  await client.upload('02-b.txt', 'SPECIMEN b');
  await client.upload('03-c.txt', 'SPECIMEN c');
  await client.listRoot();
  for (const f of ['legal', 'accounting', 'high-risk'] as const) await client.list(f);
  await client.read(a.id);
  await client.folderOf(a.id);
  await client.move(a.id, 'high-risk');
  await client.trash(a.id);
  await client.folderOf(outside);
  await client.read(outside).catch(() => undefined);
  await client.move(outside, 'legal').catch(() => undefined);
  await client.trash(outside).catch(() => undefined);
  return { outside, outsideFolder };
}

describe('GoogleDriveClient (stubbed drive_v3)', () => {
  it('scopes every list query to the root or one of its subfolders', async () => {
    const { files, client } = setup();
    await exercise(files, client);
    const tree = treeIds(files);
    const lists = files.calls.filter((c) => c.method === 'list');
    expect(lists.length).toBeGreaterThan(0);
    for (const c of lists) {
      const qs = String(c.params.q);
      const parents = parentsInQuery(qs);
      expect(parents, qs).toHaveLength(1);
      expect(tree.has(parents[0]!), qs).toBe(true);
      expect(qs).toContain('trashed = false');
    }
  });

  it('sets supportsAllDrives on every call and includeItemsFromAllDrives on every list', async () => {
    const { files, client } = setup();
    await exercise(files, client);
    for (const c of files.calls) {
      if (c.method === 'export') continue; // files.export has no supportsAllDrives parameter
      expect(c.params.supportsAllDrives, c.method).toBe(true);
      if (c.method === 'list') expect(c.params.includeItemsFromAllDrives).toBe(true);
    }
  });

  it('never writes to or downloads anything outside the tree', async () => {
    const { files, client } = setup();
    const { outside, outsideFolder } = await exercise(files, client);
    const touches = (c: StubCall) =>
      c.params.fileId === outside ||
      c.params.fileId === outsideFolder ||
      String(c.params.addParents ?? '').includes(outsideFolder) ||
      JSON.stringify(c.params.requestBody ?? {}).includes(outsideFolder);
    const writes = files.calls.filter((c) => c.method === 'update' || c.method === 'create' || c.method === 'export');
    expect(writes.filter(touches)).toEqual([]);
    // The only call naming an outside id is a metadata lookup (the scope check).
    for (const c of files.calls.filter(touches)) {
      expect(c.method).toBe('get');
      expect(c.params.alt).toBeUndefined();
    }
    expect(files.items.get(outside)).toMatchObject({ trashed: false, parents: [outsideFolder] });
  });

  it('lists the root without folders', async () => {
    const { files, client } = setup();
    await client.ensureSubfolders();
    files.add({ name: 'note.txt', parents: [ROOT] });
    files.calls.length = 0;
    expect((await client.listRoot()).map((f) => f.name)).toEqual(['note.txt']);
    const qs = String(files.calls.find((c) => c.method === 'list')!.params.q);
    expect(qs).toBe(`'${ROOT}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`);
  });

  it('ensureSubfolders creates each folder once and then reuses it', async () => {
    const { files, client } = setup();
    const first = await client.ensureSubfolders();
    // A fresh client (new process) finds the existing folders instead of creating more.
    const again = await new GoogleDriveClient({ files }, ROOT).ensureSubfolders();
    expect(again).toEqual(first);
    const creates = files.calls.filter((c) => c.method === 'create');
    expect(creates.map((c) => (c.params.requestBody as { name: string }).name)).toEqual([
      'Legal',
      'Accounting',
      'High Risk',
    ]);
    for (const c of creates) {
      expect(c.params.requestBody).toMatchObject({ mimeType: FOLDER_MIME, parents: [ROOT] });
    }
  });

  it('follows nextPageToken', async () => {
    const { files, client } = setup();
    files.pageSize = 2;
    for (let i = 1; i <= 5; i++) files.add({ name: `f${i}.txt`, parents: [ROOT] });
    expect((await client.listRoot()).map((f) => f.name)).toEqual(['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
    expect(files.calls.filter((c) => c.method === 'list')).toHaveLength(3);
  });

  it('moves by swapping parents', async () => {
    const { files, client } = setup();
    const subs = await client.ensureSubfolders();
    const f = await client.upload('x.txt', 'x');
    await client.move(f.id, 'legal');
    const upd = files.calls.filter((c) => c.method === 'update').at(-1)!;
    expect(upd.params).toMatchObject({ fileId: f.id, addParents: subs.legal, removeParents: ROOT });
  });

  it('uploads text/plain into the target folder', async () => {
    const { files, client } = setup();
    await client.upload('11-vendor-invoice-0207.txt', 'SPECIMEN invoice');
    const c = files.calls.find((x) => x.method === 'create')!;
    expect(c.params).toMatchObject({
      requestBody: { name: '11-vendor-invoice-0207.txt', parents: [ROOT], mimeType: 'text/plain' },
      media: { mimeType: 'text/plain', body: 'SPECIMEN invoice' },
    });
  });

  it('reads plain files with alt=media and exports Google Docs as text', async () => {
    const { files, client } = setup();
    const txt = files.add({ name: 'a.txt', content: 'plain', parents: [ROOT] });
    const doc = files.add({
      name: 'Doc',
      content: 'exported',
      mimeType: 'application/vnd.google-apps.document',
      parents: [ROOT],
    });
    expect(await client.read(txt)).toEqual({ id: txt, name: 'a.txt', content: 'plain' });
    expect(await client.read(doc)).toEqual({ id: doc, name: 'Doc', content: 'exported' });
    expect(files.calls.find((c) => c.method === 'get' && c.params.alt === 'media')!.params.fileId).toBe(txt);
    expect(files.calls.find((c) => c.method === 'export')!.params).toMatchObject({ fileId: doc, mimeType: 'text/plain' });
  });

  it('trashes with trashed=true (never a permanent delete)', async () => {
    const { files, client } = setup();
    const f = await client.upload('x.txt', 'x');
    await client.trash(f.id);
    const upd = files.calls.filter((c) => c.method === 'update').at(-1)!;
    expect(upd.params).toMatchObject({ fileId: f.id, requestBody: { trashed: true } });
    expect(files.items.get(f.id)!.trashed).toBe(true);
  });

  it('propagates non-404 errors and maps 404 to scope errors', async () => {
    const { files, client } = setup();
    await expect(client.read('missing')).rejects.toBeInstanceOf(DriveScopeError);
    files.get = async () => {
      throw Object.assign(new Error('boom'), { code: 500 });
    };
    await expect(client.folderOf('anything')).rejects.toThrow('boom');
  });

  it('escapes quotes in query values', () => {
    expect(q("it's")).toBe("'it\\'s'");
    expect(q('a\\b')).toBe("'a\\\\b'");
  });

  it('requires a root id', () => {
    expect(() => new GoogleDriveClient({ files: new FakeDriveFilesApi() }, '')).toThrow(/root folder id/);
  });
});

describe('GoogleDriveClient timeouts and retries (fake timers)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Apply `behaviors` in order to calls matching `match`; later calls behave normally. */
  function script(files: FakeDriveFilesApi, match: (c: StubCall) => boolean, behaviors: StubBehavior[]) {
    const queue = [...behaviors];
    files.intercept = (c) => (match(c) ? queue.shift() : undefined);
  }
  const isMedia = (c: StubCall) => c.method === 'get' && c.params.alt === 'media';
  const isRootList = (c: StubCall) =>
    c.method === 'list' && String(c.params.q).startsWith(`'${ROOT}' in parents`) && String(c.params.q).includes('!=');

  it('passes the timeout and an abort signal on every request', async () => {
    const { files, client } = setup();
    await exercise(files, client);
    for (const c of files.calls) {
      expect(c.options?.timeout, c.method).toBe(DEFAULT_TIMEOUT_MS);
      expect(c.options?.signal, c.method).toBeInstanceOf(AbortSignal);
    }
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });

  it('read rejects after the timeout, naming the operation and file id', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    const id = files.add({ name: '10-settlement.txt', content: 'x', parents: [ROOT] });
    files.intercept = (c) => (isMedia(c) ? 'hang' : undefined);
    let settled = false;
    const p = client.read(id).finally(() => {
      settled = true;
    });
    const assertion = expect(p).rejects.toThrow(
      new RegExp(`Drive read\\(${id}\\) failed after 3 attempt\\(s\\): Drive read\\(${id}\\) timed out after 20000 ms`),
    );
    // 3 attempts of 20 s with 0.5 s and 1 s backoff between them.
    await vi.advanceTimersByTimeAsync(61_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(DriveRequestError);
    const media = files.calls.filter(isMedia);
    expect(media).toHaveLength(3);
    expect(media.every((c) => c.options?.signal?.aborted)).toBe(true);
  });

  it('read with retries: 0 rejects at exactly the configured timeout', async () => {
    vi.useFakeTimers();
    const files = new FakeDriveFilesApi();
    const client = new GoogleDriveClient({ files }, ROOT, { timeoutMs: 5_000, retries: 0 });
    const id = files.add({ name: 'a.txt', parents: [ROOT] });
    files.intercept = (c) => (isMedia(c) ? 'hang' : undefined);
    const assertion = expect(client.read(id)).rejects.toThrow(/timed out after 5000 ms/);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(files.calls.filter(isMedia)).toHaveLength(1);
  });

  it('list retries a hang and a 503, then succeeds', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    files.add({ name: '10-settlement.txt', parents: [ROOT] });
    script(files, isRootList, ['hang', { error: Object.assign(new Error('backend'), { code: 503 }) }]);
    const p = client.listRoot();
    await vi.advanceTimersByTimeAsync(20_000 + 500 + 1_000);
    expect((await p).map((f) => f.name)).toEqual(['10-settlement.txt']);
    expect(files.calls.filter(isRootList)).toHaveLength(3);
  });

  it('list does not retry a 403', async () => {
    const { files, client } = setup();
    script(files, isRootList, [{ error: Object.assign(new Error('forbidden'), { code: 403 }) }]);
    await expect(client.listRoot()).rejects.toThrow('forbidden');
    expect(files.calls.filter(isRootList)).toHaveLength(1);
  });

  it('a move that timed out but landed is treated as success, without a second update', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    const subs = await client.ensureSubfolders();
    const f = await client.upload('10-settlement.txt', 'x');
    script(files, (c) => c.method === 'update', ['apply-then-hang']);
    const p = client.move(f.id, 'high-risk');
    await vi.advanceTimersByTimeAsync(20_000 + 500);
    expect(await p).toEqual({ id: f.id, name: '10-settlement.txt', folder: 'high-risk' });
    expect(files.calls.filter((c) => c.method === 'update')).toHaveLength(1);
    expect(files.items.get(f.id)!.parents).toEqual([subs['high-risk']]);
  });

  it('a move that timed out and did not land is retried after re-reading the parents', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    const subs = await client.ensureSubfolders();
    const f = await client.upload('05-invoice.txt', 'x');
    script(files, (c) => c.method === 'update', ['hang']);
    const p = client.move(f.id, 'accounting');
    await vi.advanceTimersByTimeAsync(20_000 + 500);
    expect((await p).folder).toBe('accounting');
    const updates = files.calls.filter((c) => c.method === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1]!.params).toMatchObject({ addParents: subs.accounting, removeParents: ROOT });
    expect(files.items.get(f.id)!.parents).toEqual([subs.accounting]);
  });

  it('a move that keeps timing out rejects naming move and the file id', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    await client.ensureSubfolders();
    const f = await client.upload('10.txt', 'x');
    files.intercept = (c) => (c.method === 'update' ? 'hang' : undefined);
    const assertion = expect(client.move(f.id, 'legal')).rejects.toThrow(
      new RegExp(`Drive move\\(${f.id}\\) failed after 3 attempt\\(s\\)`),
    );
    await vi.advanceTimersByTimeAsync(61_500);
    await assertion;
    expect(await client.folderOf(f.id)).toBe('root');
  });

  it('upload is never retried', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    files.intercept = (c) => (c.method === 'create' ? 'hang' : undefined);
    const assertion = expect(client.upload('11-vendor-invoice-0207.txt', 'x')).rejects.toThrow(
      /Drive upload\(11-vendor-invoice-0207\.txt\) failed after 1 attempt\(s\): .*timed out after 20000 ms/,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.calls.filter((c) => c.method === 'create')).toHaveLength(1);
  });

  it('a trash that timed out but landed is treated as success', async () => {
    vi.useFakeTimers();
    const { files, client } = setup();
    const f = await client.upload('a.txt', 'x');
    script(files, (c) => c.method === 'update', ['apply-then-hang']);
    const p = client.trash(f.id);
    await vi.advanceTimersByTimeAsync(20_500);
    await p;
    expect(files.calls.filter((c) => c.method === 'update')).toHaveLength(1);
    expect(files.items.get(f.id)!.trashed).toBe(true);
  });

  it('classifies retryable errors', () => {
    const err = (props: object) => Object.assign(new Error('x'), props);
    expect(isRetryable(err({ code: 429 }))).toBe(true);
    expect(isRetryable(err({ status: 500 }))).toBe(true);
    expect(isRetryable(err({ response: { status: 503 } }))).toBe(true);
    expect(isRetryable(err({ code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryable(err({ cause: { code: 'ETIMEDOUT' } }))).toBe(true);
    expect(isRetryable(err({ code: 404 }))).toBe(false);
    expect(isRetryable(err({ code: 403 }))).toBe(false);
    expect(isRetryable(new Error('plain'))).toBe(false);
  });

  it('the factory sets the timeout (default 20 s, configurable)', async () => {
    const config = loadConfig({
      repoRoot: join(tmpdir(), 'clearance-no-such-root'),
      env: { GDRIVE_ROOT_FOLDER_ID: 'folder-synthetic-1' },
    });
    const authFactory = async () => new google.auth.OAuth2();
    const dflt = (await createDriveClient({ config, authFactory })) as GoogleDriveClient;
    const custom = (await createDriveClient({ config, authFactory, timeoutMs: 5_000 })) as GoogleDriveClient;
    expect(dflt.timeoutMs).toBe(20_000);
    expect(custom.timeoutMs).toBe(5_000);
  });
});
