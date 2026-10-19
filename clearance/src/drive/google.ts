// Google Drive implementation of DriveClient over drive_v3. It takes an
// already-authorised client (auth and the factory are T3.2). Every query is
// scoped to the root folder or one of its three subfolders, and every call
// sets supportsAllDrives so Shared Drives work.
import type { drive_v3 } from 'googleapis';
import {
  type DriveClient,
  type DriveFile,
  type DriveFileContent,
  DriveScopeError,
  FOLDER_MIME,
  type FolderKey,
  type FolderOf,
  SUBFOLDER_KEYS,
  SUBFOLDER_NAMES,
  type SubfolderIds,
  type SubfolderKey,
} from './types';

interface Resp<T> {
  data: T;
}
type TextOpts = { responseType: 'text' };

/**
 * The slice of `drive_v3.Drive['files']` this client uses. Narrow on purpose:
 * tests stub exactly this, with no network.
 */
export interface DriveFilesApi {
  list(params: drive_v3.Params$Resource$Files$List): Promise<Resp<drive_v3.Schema$FileList>>;
  get(params: drive_v3.Params$Resource$Files$Get, options?: TextOpts): Promise<Resp<unknown>>;
  create(params: drive_v3.Params$Resource$Files$Create): Promise<Resp<drive_v3.Schema$File>>;
  update(params: drive_v3.Params$Resource$Files$Update): Promise<Resp<drive_v3.Schema$File>>;
  export(params: drive_v3.Params$Resource$Files$Export, options?: TextOpts): Promise<Resp<unknown>>;
}

const FILE_FIELDS = 'id, name, mimeType, parents, trashed';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const ALL_DRIVES = { supportsAllDrives: true } as const;

/** Quote a value for a Drive `q` string. */
export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return e?.code === 404 || e?.code === '404' || e?.status === 404 || e?.response?.status === 404;
}

export class GoogleDriveClient implements DriveClient {
  private readonly files: DriveFilesApi;
  private readonly subIds: Partial<SubfolderIds> = {};

  /** `drive` is an authorised `google.drive({ version: 'v3', auth })`, or a DriveFilesApi stub. */
  constructor(
    drive: drive_v3.Drive | { files: DriveFilesApi },
    readonly rootId: string,
  ) {
    if (!rootId) throw new Error('GoogleDriveClient needs the root folder id.');
    // drive_v3's overloaded methods don't line up structurally with the
    // narrow interface, but the runtime shape is the same.
    this.files = drive.files as unknown as DriveFilesApi;
  }

  listRoot(): Promise<DriveFile[]> {
    return this.list('root');
  }

  async list(folder: FolderKey): Promise<DriveFile[]> {
    const parentId = await this.folderId(folder, false);
    if (!parentId) return [];
    const items = await this.query(`${q(parentId)} in parents and trashed = false and mimeType != ${q(FOLDER_MIME)}`);
    return items.map((f) => ({ id: f.id!, name: f.name ?? '', folder }));
  }

  async read(fileId: string): Promise<DriveFileContent> {
    const meta = await this.locate(fileId);
    let data: unknown;
    if (meta.file.mimeType === GOOGLE_DOC_MIME) {
      ({ data } = await this.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' }));
    } else {
      ({ data } = await this.files.get({ fileId, alt: 'media', ...ALL_DRIVES }, { responseType: 'text' }));
    }
    return { id: fileId, name: meta.file.name ?? '', content: typeof data === 'string' ? data : String(data ?? '') };
  }

  async move(fileId: string, folder: FolderKey): Promise<DriveFile> {
    const meta = await this.locate(fileId);
    const target = (await this.folderId(folder, true))!;
    const name = meta.file.name ?? '';
    if (meta.folder === folder) return { id: fileId, name, folder };
    await this.files.update({
      fileId,
      addParents: target,
      removeParents: (meta.file.parents ?? []).join(','),
      fields: FILE_FIELDS,
      ...ALL_DRIVES,
    });
    return { id: fileId, name, folder };
  }

  async upload(name: string, content: string, folder: FolderKey = 'root'): Promise<DriveFile> {
    const parent = (await this.folderId(folder, true))!;
    const { data } = await this.files.create({
      requestBody: { name, parents: [parent], mimeType: 'text/plain' },
      media: { mimeType: 'text/plain', body: content },
      fields: FILE_FIELDS,
      ...ALL_DRIVES,
    });
    if (!data.id) throw new Error(`Drive did not return an id for uploaded file ${name}.`);
    return { id: data.id, name: data.name ?? name, folder };
  }

  async trash(fileId: string): Promise<void> {
    await this.locate(fileId);
    await this.files.update({ fileId, requestBody: { trashed: true }, fields: 'id', ...ALL_DRIVES });
  }

  async ensureSubfolders(): Promise<SubfolderIds> {
    const out = {} as SubfolderIds;
    for (const key of SUBFOLDER_KEYS) out[key] = (await this.subfolderId(key, true))!;
    return out;
  }

  async folderOf(fileId: string): Promise<FolderOf> {
    const file = await this.getMeta(fileId);
    return file ? this.classify(file) : 'other';
  }

  // ---- internals ----

  private async query(qs: string): Promise<drive_v3.Schema$File[]> {
    const out: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.files.list({
        q: qs,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        pageSize: 1000,
        orderBy: 'createdTime',
        includeItemsFromAllDrives: true,
        ...ALL_DRIVES,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const f of data.files ?? []) if (f.id) out.push(f);
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  private async folderId(folder: FolderKey, create: boolean): Promise<string | undefined> {
    return folder === 'root' ? this.rootId : this.subfolderId(folder, create);
  }

  /** Find (or with `create`, make) a subfolder directly under the root. Found ids are cached. */
  private async subfolderId(key: SubfolderKey, create: boolean): Promise<string | undefined> {
    const cached = this.subIds[key];
    if (cached) return cached;
    const name = SUBFOLDER_NAMES[key];
    const found = await this.query(
      `${q(this.rootId)} in parents and trashed = false and mimeType = ${q(FOLDER_MIME)} and name = ${q(name)}`,
    );
    let id = found[0]?.id ?? undefined;
    if (!id && create) {
      const { data } = await this.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [this.rootId] },
        fields: 'id',
        ...ALL_DRIVES,
      });
      id = data.id ?? undefined;
      if (!id) throw new Error(`Drive did not return an id for folder ${name}.`);
    }
    if (id) this.subIds[key] = id;
    return id;
  }

  private async getMeta(fileId: string): Promise<drive_v3.Schema$File | undefined> {
    try {
      const { data } = await this.files.get({ fileId, fields: FILE_FIELDS, ...ALL_DRIVES });
      return data as drive_v3.Schema$File;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  private async classify(file: drive_v3.Schema$File): Promise<FolderOf> {
    if (file.trashed || file.mimeType === FOLDER_MIME) return 'other';
    const parents = file.parents ?? [];
    if (parents.includes(this.rootId)) return 'root';
    for (const key of SUBFOLDER_KEYS) {
      const id = await this.subfolderId(key, false);
      if (id && parents.includes(id)) return key;
    }
    return 'other';
  }

  /** Metadata plus folder for a tree file; DriveScopeError for anything else. */
  private async locate(fileId: string): Promise<{ file: drive_v3.Schema$File; folder: FolderKey }> {
    const file = await this.getMeta(fileId);
    const folder = file ? await this.classify(file) : 'other';
    if (!file || folder === 'other') throw new DriveScopeError(fileId);
    return { file, folder };
  }
}
