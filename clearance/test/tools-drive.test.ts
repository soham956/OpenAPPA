import { beforeEach, describe, expect, it } from 'vitest';
import { FakeDriveClient } from '../src/drive/fake';
import { DriveScopeError, type FolderKey } from '../src/drive/types';
import { driveList, driveRead } from '../src/tools/drive';

let fake: FakeDriveClient;
beforeEach(async () => {
  fake = new FakeDriveClient();
  await fake.ensureSubfolders();
});

describe('driveList', () => {
  it('returns names and ids for a folder', async () => {
    const a = await fake.upload('01-a.txt', 'A');
    const b = await fake.upload('02-b.txt', 'B');
    expect(await driveList(fake, { folder: 'root' })).toEqual([
      { id: a.id, name: '01-a.txt' },
      { id: b.id, name: '02-b.txt' },
    ]);
  });

  it('lists a subfolder separately and empty folders as []', async () => {
    const l = await fake.upload('l.txt', 'L', 'legal');
    expect(await driveList(fake, { folder: 'legal' })).toEqual([{ id: l.id, name: 'l.txt' }]);
    expect(await driveList(fake, { folder: 'accounting' })).toEqual([]);
  });

  it('rejects an unknown folder', async () => {
    await expect(driveList(fake, { folder: 'other' as FolderKey })).rejects.toThrow(TypeError);
  });
});

describe('driveRead', () => {
  it('returns name, content and folder', async () => {
    const f = await fake.upload('03-c.txt', 'hello', 'high-risk');
    expect(await driveRead(fake, { fileId: f.id })).toEqual({ name: '03-c.txt', content: 'hello', folder: 'high-risk' });
  });

  it('reports the current folder after a move', async () => {
    const f = await fake.upload('04-d.txt', 'x');
    await fake.move(f.id, 'legal');
    expect((await driveRead(fake, { fileId: f.id })).folder).toBe('legal');
  });

  it('throws DriveScopeError outside the tree', async () => {
    const out = fake.addOutsideFile('secret.txt', 'nope');
    await expect(driveRead(fake, { fileId: out })).rejects.toBeInstanceOf(DriveScopeError);
    await expect(driveRead(fake, { fileId: 'missing' })).rejects.toBeInstanceOf(DriveScopeError);
  });

  it('rejects an empty file id', async () => {
    await expect(driveRead(fake, { fileId: '' })).rejects.toThrow(TypeError);
  });
});
