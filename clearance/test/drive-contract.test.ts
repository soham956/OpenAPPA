// One DriveClient contract, run against the in-memory fake and against
// GoogleDriveClient over a stubbed drive_v3 (no network).
import { describe, expect, it } from 'vitest';
import { FakeDriveClient, FakeDriveFilesApi } from '../src/drive/fake';
import { GoogleDriveClient } from '../src/drive/google';
import { type DriveClient, DriveScopeError, FOLDER_MIME, SUBFOLDER_NAMES } from '../src/drive/types';

interface Harness {
  client: DriveClient;
  /** Plant a file outside the root tree; returns its id. */
  addOutsideFile(name: string, content: string): string;
  /** Plant a non-Clearance folder directly in the root; returns its id. */
  addRootFolder(name: string): string;
  /** Names of the non-trashed folders directly under the root. */
  rootFolderNames(): string[];
}

const ROOT = 'root-folder-id';

function fakeHarness(): Harness {
  const client = new FakeDriveClient(ROOT);
  return {
    client,
    addOutsideFile: (name, content) => client.addOutsideFile(name, content),
    addRootFolder: (name) => client.addRootFolder(name),
    rootFolderNames: () =>
      [...client.items.values()]
        .filter((i) => i.parent === ROOT && !i.trashed && i.mimeType === FOLDER_MIME)
        .map((i) => i.name)
        .sort(),
  };
}

function googleHarness(): Harness {
  const files = new FakeDriveFilesApi();
  const elsewhere = files.add({ name: 'My Drive elsewhere', mimeType: FOLDER_MIME, parents: ['my-drive'] });
  return {
    client: new GoogleDriveClient({ files }, ROOT),
    addOutsideFile: (name, content) => files.add({ name, content, parents: [elsewhere] }),
    addRootFolder: (name) => files.add({ name, mimeType: FOLDER_MIME, parents: [ROOT] }),
    rootFolderNames: () =>
      [...files.items.values()]
        .filter((i) => i.parents.includes(ROOT) && !i.trashed && i.mimeType === FOLDER_MIME)
        .map((i) => i.name)
        .sort(),
  };
}

const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();

describe.each([
  ['FakeDriveClient', fakeHarness],
  ['GoogleDriveClient (stubbed drive_v3)', googleHarness],
])('DriveClient contract: %s', (_label, make) => {
  it('exposes the root id', () => {
    expect(make().client.rootId).toBe(ROOT);
  });

  it('ensureSubfolders creates Legal, Accounting and High Risk, and is idempotent', async () => {
    const h = make();
    const first = await h.client.ensureSubfolders();
    const second = await h.client.ensureSubfolders();
    expect(second).toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(3);
    expect(h.rootFolderNames()).toEqual(['Accounting', 'High Risk', 'Legal']);
    expect(Object.values(SUBFOLDER_NAMES).sort()).toEqual(['Accounting', 'High Risk', 'Legal']);
  });

  it('upload, listRoot and read round-trip; listing the root excludes folders', async () => {
    const h = make();
    await h.client.ensureSubfolders();
    h.addRootFolder('Some other folder');
    const a = await h.client.upload('01-a.txt', 'SPECIMEN alpha');
    await h.client.upload('02-b.txt', "SPECIMEN it's beta");
    await h.client.upload('03-c.txt', 'SPECIMEN gamma');
    expect(a).toMatchObject({ name: '01-a.txt', folder: 'root' });
    const root = await h.client.listRoot();
    expect(names(root)).toEqual(['01-a.txt', '02-b.txt', '03-c.txt']);
    expect(root.every((f) => f.folder === 'root')).toBe(true);
    expect(await h.client.list('root')).toEqual(root);
    expect(await h.client.read(a.id)).toEqual({ id: a.id, name: '01-a.txt', content: 'SPECIMEN alpha' });
  });

  it('lists a missing subfolder as empty without creating it', async () => {
    const h = make();
    expect(await h.client.list('legal')).toEqual([]);
    expect(h.rootFolderNames()).toEqual([]);
  });

  it('move puts a file in a subfolder and folderOf follows it', async () => {
    const h = make();
    await h.client.ensureSubfolders();
    const f = await h.client.upload('08-x.txt', 'SPECIMEN SPC-4417-2290');
    expect(await h.client.folderOf(f.id)).toBe('root');
    expect(await h.client.move(f.id, 'high-risk')).toEqual({ id: f.id, name: '08-x.txt', folder: 'high-risk' });
    expect(await h.client.folderOf(f.id)).toBe('high-risk');
    expect(await h.client.listRoot()).toEqual([]);
    expect(names(await h.client.list('high-risk'))).toEqual(['08-x.txt']);
    // A person moving it out of High Risk is seen at once (no caching).
    await h.client.move(f.id, 'legal');
    expect(await h.client.folderOf(f.id)).toBe('legal');
    expect(await h.client.list('high-risk')).toEqual([]);
    expect(names(await h.client.list('legal'))).toEqual(['08-x.txt']);
    // Moving to the folder it is already in is a no-op.
    await h.client.move(f.id, 'legal');
    expect(await h.client.folderOf(f.id)).toBe('legal');
  });

  it('move creates the target subfolder if it is missing', async () => {
    const h = make();
    const f = await h.client.upload('05-inv.txt', 'SPECIMEN invoice');
    await h.client.move(f.id, 'accounting');
    expect(await h.client.folderOf(f.id)).toBe('accounting');
    expect(h.rootFolderNames()).toEqual(['Accounting']);
  });

  it('upload into a subfolder', async () => {
    const h = make();
    const f = await h.client.upload('01-l.txt', 'SPECIMEN legal', 'legal');
    expect(f.folder).toBe('legal');
    expect(await h.client.folderOf(f.id)).toBe('legal');
    expect(await h.client.listRoot()).toEqual([]);
  });

  it('folderOf returns other for outside files, folders, trashed and unknown ids', async () => {
    const h = make();
    const subs = await h.client.ensureSubfolders();
    const outside = h.addOutsideFile('payroll.txt', 'not ours');
    const t = await h.client.upload('gone.txt', 'x');
    await h.client.trash(t.id);
    expect(await h.client.folderOf(outside)).toBe('other');
    expect(await h.client.folderOf(subs.legal)).toBe('other');
    expect(await h.client.folderOf(h.client.rootId)).toBe('other');
    expect(await h.client.folderOf(t.id)).toBe('other');
    expect(await h.client.folderOf('no-such-id')).toBe('other');
  });

  it('trash removes a file from listings', async () => {
    const h = make();
    await h.client.ensureSubfolders();
    const a = await h.client.upload('a.txt', 'a');
    const b = await h.client.upload('b.txt', 'b', 'accounting');
    await h.client.trash(a.id);
    await h.client.trash(b.id);
    expect(await h.client.listRoot()).toEqual([]);
    expect(await h.client.list('accounting')).toEqual([]);
  });

  it('refuses read, move and trash outside the tree', async () => {
    const h = make();
    const subs = await h.client.ensureSubfolders();
    const outside = h.addOutsideFile('payroll.txt', 'not ours');
    for (const id of [outside, 'no-such-id', subs['high-risk']]) {
      await expect(h.client.read(id)).rejects.toBeInstanceOf(DriveScopeError);
      await expect(h.client.move(id, 'legal')).rejects.toBeInstanceOf(DriveScopeError);
      await expect(h.client.trash(id)).rejects.toBeInstanceOf(DriveScopeError);
    }
    // The subfolder was not trashed or moved.
    expect(h.rootFolderNames()).toEqual(['Accounting', 'High Risk', 'Legal']);
    expect(await h.client.folderOf(outside)).toBe('other');
  });

  it('never lists files from outside the tree', async () => {
    const h = make();
    await h.client.ensureSubfolders();
    h.addOutsideFile('payroll.txt', 'not ours');
    await h.client.upload('in-legal.txt', 'x', 'legal');
    expect(await h.client.listRoot()).toEqual([]);
    expect(names(await h.client.list('legal'))).toEqual(['in-legal.txt']);
    expect(await h.client.list('accounting')).toEqual([]);
  });
});

describe('FakeDriveClient id recording', () => {
  it('records every id it is asked about, flagging ids outside the tree', async () => {
    const d = new FakeDriveClient(ROOT);
    const a = await d.upload('a.txt', 'a');
    const outside = d.addOutsideFile('payroll.txt', 'not ours');
    await d.read(a.id);
    await d.folderOf(a.id);
    await d.move(a.id, 'legal');
    await d.trash(a.id);
    expect(d.outsideTreeIds()).toEqual([]);
    await d.folderOf(outside);
    await expect(d.read(outside)).rejects.toBeInstanceOf(DriveScopeError);
    await expect(d.trash(a.id)).rejects.toBeInstanceOf(DriveScopeError); // already trashed
    expect(d.askedIds()).toEqual([a.id, outside]);
    expect(d.outsideTreeIds()).toEqual([outside, a.id]);
    expect(d.calls.map((c) => c.op)).toEqual(['read', 'folderOf', 'move', 'trash', 'folderOf', 'read', 'trash']);
  });

  it('snapshot groups live tree files by folder', async () => {
    const d = new FakeDriveClient(ROOT);
    await d.ensureSubfolders();
    await d.upload('b.txt', 'b');
    await d.upload('a.txt', 'a');
    await d.upload('l.txt', 'l', 'legal');
    d.addOutsideFile('x.txt');
    expect(d.snapshot()).toEqual({ root: ['a.txt', 'b.txt'], legal: ['l.txt'], accounting: [], 'high-risk': [] });
  });
});
