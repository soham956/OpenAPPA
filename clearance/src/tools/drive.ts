// Drive tools: `drive_list` and `drive_read`. Plain functions over an injected
// DriveClient; they never call APPA (only the guard does). Owned by T11.2.
import { type DriveClient, DriveScopeError, type FolderKey, isFolderKey } from '../drive/types';

export interface DriveListEntry {
  id: string;
  name: string;
}

export interface DriveReadResult {
  name: string;
  content: string;
  folder: FolderKey;
}

/** Names and ids of the files directly in `folder`. */
export async function driveList(client: DriveClient, args: { folder: FolderKey }): Promise<DriveListEntry[]> {
  if (!isFolderKey(args.folder)) throw new TypeError('drive_list: "folder" must be root, legal, accounting or high-risk');
  const files = await client.list(args.folder);
  return files.map((f) => ({ id: f.id, name: f.name }));
}

/**
 * Name, text content and current folder of a file. Throws DriveScopeError when the
 * file is outside the Clearance tree (the read itself refuses, so no content leaks).
 */
export async function driveRead(client: DriveClient, args: { fileId: string }): Promise<DriveReadResult> {
  if (typeof args.fileId !== 'string' || args.fileId === '') throw new TypeError('drive_read: "fileId" must be a non-empty string');
  const { name, content } = await client.read(args.fileId);
  const where = await client.folderOf(args.fileId);
  // `read` already refused anything outside the tree; this covers a file moved out in between.
  if (where === 'other') throw new DriveScopeError(args.fileId);
  return { name, content, folder: where };
}
