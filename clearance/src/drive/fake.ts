// In-memory DriveClient with the same behaviour as GoogleDriveClient. Every
// file id it is asked about is recorded, so tests can assert that nothing
// outside the Clearance tree was touched.
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

export interface FakeItem {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  content: string;
  trashed: boolean;
}

export type FakeOp = 'read' | 'move' | 'trash' | 'folderOf';

export interface FakeCall {
  op: FakeOp;
  fileId: string;
  /** Whether the id was a file in the tree when it was asked about. */
  inTree: boolean;
}

/** Parent id used for items planted outside the tree. */
export const FAKE_OUTSIDE_PARENT = 'fake-outside';

export class FakeDriveClient implements DriveClient {
  readonly items = new Map<string, FakeItem>();
  /** Every per-file call, in order. */
  readonly calls: FakeCall[] = [];
  private seq = 0;

  constructor(readonly rootId = 'fake-root') {}

  // ---- DriveClient ----

  async listRoot(): Promise<DriveFile[]> {
    return this.list('root');
  }

  async list(folder: FolderKey): Promise<DriveFile[]> {
    const parent = this.folderIdOf(folder);
    if (!parent) return [];
    return [...this.items.values()]
      .filter((i) => i.parent === parent && !i.trashed && i.mimeType !== FOLDER_MIME)
      .map((i) => ({ id: i.id, name: i.name, folder }));
  }

  async read(fileId: string): Promise<DriveFileContent> {
    const { item } = this.locate('read', fileId);
    return { id: item.id, name: item.name, content: item.content };
  }

  async move(fileId: string, folder: FolderKey): Promise<DriveFile> {
    const { item } = this.locate('move', fileId);
    item.parent = this.ensureFolder(folder);
    return { id: item.id, name: item.name, folder };
  }

  async upload(name: string, content: string, folder: FolderKey = 'root'): Promise<DriveFile> {
    const parent = this.ensureFolder(folder);
    const item = this.put({ name, mimeType: 'text/plain', parent, content });
    return { id: item.id, name, folder };
  }

  async trash(fileId: string): Promise<void> {
    const { item } = this.locate('trash', fileId);
    item.trashed = true;
  }

  async ensureSubfolders(): Promise<SubfolderIds> {
    const out = {} as SubfolderIds;
    for (const key of SUBFOLDER_KEYS) out[key] = this.ensureFolder(key);
    return out;
  }

  async folderOf(fileId: string): Promise<FolderOf> {
    const folder = this.classify(fileId);
    this.calls.push({ op: 'folderOf', fileId, inTree: folder !== 'other' });
    return folder;
  }

  // ---- test helpers ----

  /** Every id any per-file call was asked about. */
  askedIds(): string[] {
    return [...new Set(this.calls.map((c) => c.fileId))];
  }

  /** Ids that were asked about while they were not tree files. */
  outsideTreeIds(): string[] {
    return [...new Set(this.calls.filter((c) => !c.inTree).map((c) => c.fileId))];
  }

  /** Plant a file outside the tree (e.g. elsewhere in My Drive). Returns its id. */
  addOutsideFile(name: string, content = ''): string {
    return this.put({ name, mimeType: 'text/plain', parent: FAKE_OUTSIDE_PARENT, content }).id;
  }

  /** Plant a non-Clearance folder directly in the root. Returns its id. */
  addRootFolder(name: string): string {
    return this.put({ name, mimeType: FOLDER_MIME, parent: this.rootId, content: '' }).id;
  }

  /** Non-trashed, non-folder files under the root tree, by folder. */
  snapshot(): Record<FolderKey, string[]> {
    const out = { root: [], legal: [], accounting: [], 'high-risk': [] } as Record<FolderKey, string[]>;
    for (const i of this.items.values()) {
      const f = this.classifyItem(i);
      if (f !== 'other') out[f].push(i.name);
    }
    for (const k of Object.keys(out) as FolderKey[]) out[k].sort();
    return out;
  }

  // ---- internals ----

  private put(fields: Omit<FakeItem, 'id' | 'trashed'>): FakeItem {
    const item: FakeItem = { id: `fake-${++this.seq}`, trashed: false, ...fields };
    this.items.set(item.id, item);
    return item;
  }

  private subfolderId(key: SubfolderKey): string | undefined {
    const name = SUBFOLDER_NAMES[key];
    for (const i of this.items.values()) {
      if (i.parent === this.rootId && !i.trashed && i.mimeType === FOLDER_MIME && i.name === name) return i.id;
    }
    return undefined;
  }

  private folderIdOf(folder: FolderKey): string | undefined {
    return folder === 'root' ? this.rootId : this.subfolderId(folder);
  }

  private ensureFolder(folder: FolderKey): string {
    if (folder === 'root') return this.rootId;
    return (
      this.subfolderId(folder) ??
      this.put({ name: SUBFOLDER_NAMES[folder], mimeType: FOLDER_MIME, parent: this.rootId, content: '' }).id
    );
  }

  private classifyItem(item: FakeItem): FolderOf {
    if (item.trashed || item.mimeType === FOLDER_MIME) return 'other';
    if (item.parent === this.rootId) return 'root';
    for (const key of SUBFOLDER_KEYS) if (item.parent === this.subfolderId(key)) return key;
    return 'other';
  }

  private classify(fileId: string): FolderOf {
    const item = this.items.get(fileId);
    return item ? this.classifyItem(item) : 'other';
  }

  private locate(op: FakeOp, fileId: string): { item: FakeItem; folder: FolderKey } {
    const item = this.items.get(fileId);
    const folder = item ? this.classifyItem(item) : 'other';
    this.calls.push({ op, fileId, inTree: folder !== 'other' });
    if (!item || folder === 'other') throw new DriveScopeError(fileId);
    return { item, folder };
  }
}

// ---- drive_v3 files stub ----

export interface StubCall {
  method: 'list' | 'get' | 'create' | 'update' | 'export';
  params: Record<string, unknown>;
}

interface StubItem {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: string;
  trashed: boolean;
}

function notFound(fileId: string): Error {
  return Object.assign(new Error(`File not found: ${fileId}.`), { code: 404 });
}

/**
 * In-memory stand-in for `drive_v3.Drive['files']`, for testing
 * GoogleDriveClient with no network. It understands only the `q` clauses the
 * client uses, throws on anything else, and records every call.
 */
export class FakeDriveFilesApi {
  readonly items = new Map<string, StubItem>();
  readonly calls: StubCall[] = [];
  /** Page size the stub returns, to exercise pagination. */
  pageSize = 2;
  private seq = 0;

  add(fields: Partial<StubItem> & { name: string; parents: string[] }): string {
    const id = fields.id ?? `g-${++this.seq}`;
    this.items.set(id, { mimeType: 'text/plain', content: '', trashed: false, ...fields, id });
    return id;
  }

  async list(params: { q?: string; pageToken?: string }) {
    this.calls.push({ method: 'list', params });
    const preds = (params.q ?? '').split(' and ').map(parseClause);
    const all = [...this.items.values()].filter((i) => preds.every((p) => p(i)));
    const start = params.pageToken ? Number(params.pageToken) : 0;
    const page = all.slice(start, start + this.pageSize);
    const next = start + this.pageSize < all.length ? String(start + this.pageSize) : undefined;
    return { data: { files: page.map(stubMeta), ...(next ? { nextPageToken: next } : {}) } };
  }

  async get(params: { fileId?: string; alt?: string }) {
    this.calls.push({ method: 'get', params });
    const item = this.items.get(params.fileId ?? '');
    if (!item) throw notFound(params.fileId ?? '');
    return { data: params.alt === 'media' ? item.content : stubMeta(item) };
  }

  async export(params: { fileId?: string }) {
    this.calls.push({ method: 'export', params });
    const item = this.items.get(params.fileId ?? '');
    if (!item) throw notFound(params.fileId ?? '');
    return { data: item.content };
  }

  async create(params: {
    requestBody?: { name?: string | null; mimeType?: string | null; parents?: string[] | null };
    media?: { body?: unknown };
  }) {
    this.calls.push({ method: 'create', params });
    const body = params.requestBody ?? {};
    const id = this.add({
      name: body.name ?? '',
      mimeType: body.mimeType ?? 'text/plain',
      parents: body.parents ?? [],
      content: params.media?.body === undefined ? '' : String(params.media.body),
    });
    return { data: stubMeta(this.items.get(id)!) };
  }

  async update(params: {
    fileId?: string;
    addParents?: string;
    removeParents?: string;
    requestBody?: { trashed?: boolean | null };
  }) {
    this.calls.push({ method: 'update', params });
    const item = this.items.get(params.fileId ?? '');
    if (!item) throw notFound(params.fileId ?? '');
    const remove = (params.removeParents ?? '').split(',').filter(Boolean);
    item.parents = item.parents.filter((p) => !remove.includes(p));
    for (const p of (params.addParents ?? '').split(',').filter(Boolean)) if (!item.parents.includes(p)) item.parents.push(p);
    if (params.requestBody?.trashed != null) item.trashed = params.requestBody.trashed;
    return { data: stubMeta(item) };
  }
}

function stubMeta(i: StubItem) {
  return { id: i.id, name: i.name, mimeType: i.mimeType, parents: [...i.parents], trashed: i.trashed };
}

function unquote(s: string): string {
  return s.slice(1, -1).replace(/\\(.)/g, '$1');
}

const QUOTED = String.raw`'(?:[^'\\]|\\.)*'`;

function parseClause(clause: string): (i: StubItem) => boolean {
  const c = clause.trim();
  let m: RegExpMatchArray | null;
  if ((m = c.match(new RegExp(`^(${QUOTED}) in parents$`)))) {
    const id = unquote(m[1]!);
    return (i) => i.parents.includes(id);
  }
  if (c === 'trashed = false') return (i) => !i.trashed;
  if ((m = c.match(new RegExp(`^(mimeType|name) (=|!=) (${QUOTED})$`)))) {
    const field = m[1] as 'mimeType' | 'name';
    const v = unquote(m[3]!);
    return m[2] === '=' ? (i) => i[field] === v : (i) => i[field] !== v;
  }
  throw new Error(`FakeDriveFilesApi: unsupported q clause: ${c}`);
}
