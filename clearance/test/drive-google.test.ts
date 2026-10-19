// GoogleDriveClient against a stubbed drive_v3 files API: no network. These
// check the request shapes (scoping, supportsAllDrives, pagination); the
// behaviour shared with the fake is in drive-contract.test.ts.
import { describe, expect, it } from 'vitest';
import { FakeDriveFilesApi, type StubCall } from '../src/drive/fake';
import { GoogleDriveClient, q } from '../src/drive/google';
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
