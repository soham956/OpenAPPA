// Google Drive implementation of DriveClient over drive_v3. It takes an
// already-authorised client (auth and the factory are T3.2). Every query is
// scoped to the root folder or one of its three subfolders, and every call
// sets supportsAllDrives so Shared Drives work.
//
// Every request has a timeout (default 20 s), enforced here as well as passed
// to gaxios, so a hung connection always rejects. Reads (list, get, export,
// folder lookup) retry on a timeout, network error, 429 or 5xx. Changes are
// never retried blindly: a failed move or trash is retried only after
// re-reading the file shows it did not land; upload and folder create are
// never retried (reset and drop are rerunnable).
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

/** Per-request options (a subset of gaxios MethodOptions). */
export interface RequestOpts {
  timeout?: number;
  signal?: AbortSignal;
  responseType?: 'text';
}

/**
 * The slice of `drive_v3.Drive['files']` this client uses. Narrow on purpose:
 * tests stub exactly this, with no network.
 */
export interface DriveFilesApi {
  list(params: drive_v3.Params$Resource$Files$List, options?: RequestOpts): Promise<Resp<drive_v3.Schema$FileList>>;
  get(params: drive_v3.Params$Resource$Files$Get, options?: RequestOpts): Promise<Resp<unknown>>;
  create(params: drive_v3.Params$Resource$Files$Create, options?: RequestOpts): Promise<Resp<drive_v3.Schema$File>>;
  update(params: drive_v3.Params$Resource$Files$Update, options?: RequestOpts): Promise<Resp<drive_v3.Schema$File>>;
  export(params: drive_v3.Params$Resource$Files$Export, options?: RequestOpts): Promise<Resp<unknown>>;
}

export interface GoogleDriveOptions {
  /** Per-request timeout in ms (default DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Retries after the first attempt for retryable failures (default 2). */
  retries?: number;
  /** First backoff in ms; doubles each retry (default 500). */
  backoffMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;

const FILE_FIELDS = 'id, name, mimeType, parents, trashed';
const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const ALL_DRIVES = { supportsAllDrives: true } as const;

/** A Drive request failed; names the operation and the file (or folder). */
export class DriveRequestError extends Error {
  constructor(
    readonly op: string,
    readonly target: string,
    readonly attempts: number,
    override readonly cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`Drive ${op}(${target}) failed after ${attempts} attempt(s): ${why}`);
    this.name = 'DriveRequestError';
  }
}

/** One attempt of a Drive request exceeded its timeout. */
export class DriveTimeoutError extends Error {
  constructor(
    readonly op: string,
    readonly target: string,
    readonly timeoutMs: number,
  ) {
    super(`Drive ${op}(${target}) timed out after ${timeoutMs} ms`);
    this.name = 'DriveTimeoutError';
  }
}

/** Quote a value for a Drive `q` string. */
export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  for (const v of [e?.status, e?.response?.status, e?.code]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n < 600) return n;
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Timeout, network error, 429 or 5xx. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof DriveTimeoutError) return true;
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status >= 500;
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  if (typeof e?.code === 'string' && NETWORK_CODES.has(e.code)) return true;
  if (typeof e?.cause?.code === 'string' && NETWORK_CODES.has(e.cause.code)) return true;
  return e?.name === 'AbortError' || e?.name === 'FetchError' || e?.name === 'TimeoutError';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GoogleDriveClient implements DriveClient {
  private readonly files: DriveFilesApi;
  private readonly subIds: Partial<SubfolderIds> = {};
  readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  /** `drive` is an authorised `google.drive({ version: 'v3', auth })`, or a DriveFilesApi stub. */
  constructor(
    drive: drive_v3.Drive | { files: DriveFilesApi },
    readonly rootId: string,
    opts: GoogleDriveOptions = {},
  ) {
    if (!rootId) throw new Error('GoogleDriveClient needs the root folder id.');
    // drive_v3's overloaded methods don't line up structurally with the
    // narrow interface, but the runtime shape is the same.
    this.files = drive.files as unknown as DriveFilesApi;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  listRoot(): Promise<DriveFile[]> {
    return this.list('root');
  }

  async list(folder: FolderKey): Promise<DriveFile[]> {
    const parentId = await this.folderId(folder, false);
    if (!parentId) return [];
    const items = await this.query(
      `list`,
      folder,
      `${q(parentId)} in parents and trashed = false and mimeType != ${q(FOLDER_MIME)}`,
    );
    return items.map((f) => ({ id: f.id!, name: f.name ?? '', folder }));
  }

  async read(fileId: string): Promise<DriveFileContent> {
    const meta = await this.locate('read', fileId);
    const data = await this.idempotent('read', fileId, (o) =>
      meta.file.mimeType === GOOGLE_DOC_MIME
        ? this.files.export({ fileId, mimeType: 'text/plain' }, { ...o, responseType: 'text' })
        : this.files.get({ fileId, alt: 'media', ...ALL_DRIVES }, { ...o, responseType: 'text' }),
    );
    const body = data.data;
    return { id: fileId, name: meta.file.name ?? '', content: typeof body === 'string' ? body : String(body ?? '') };
  }

  async move(fileId: string, folder: FolderKey): Promise<DriveFile> {
    let meta = await this.locate('move', fileId);
    const target = (await this.folderId(folder, true))!;
    const name = meta.file.name ?? '';
    const done = { id: fileId, name, folder };
    for (let attempt = 1; ; attempt++) {
      if (meta.folder === folder) return done;
      try {
        await this.once('move', fileId, (o) =>
          this.files.update(
            {
              fileId,
              addParents: target,
              removeParents: (meta.file.parents ?? []).join(','),
              fields: FILE_FIELDS,
              ...ALL_DRIVES,
            },
            o,
          ),
        );
        return done;
      } catch (err) {
        if (!isRetryable(err) || attempt > this.retries) throw new DriveRequestError('move', fileId, attempt, err);
        await sleep(this.backoff(attempt));
        // The change may have landed server-side: re-read before retrying.
        meta = await this.locate('move', fileId);
      }
    }
  }

  async upload(name: string, content: string, folder: FolderKey = 'root'): Promise<DriveFile> {
    const parent = (await this.folderId(folder, true))!;
    let data: drive_v3.Schema$File;
    try {
      ({ data } = await this.once('upload', name, (o) =>
        this.files.create(
          {
            requestBody: { name, parents: [parent], mimeType: 'text/plain' },
            media: { mimeType: 'text/plain', body: content },
            fields: FILE_FIELDS,
            ...ALL_DRIVES,
          },
          o,
        ),
      ));
    } catch (err) {
      // Never retried: a timed-out create may have landed, and a retry would duplicate it.
      throw new DriveRequestError('upload', name, 1, err);
    }
    if (!data.id) throw new Error(`Drive did not return an id for uploaded file ${name}.`);
    return { id: data.id, name: data.name ?? name, folder };
  }

  async trash(fileId: string): Promise<void> {
    await this.locate('trash', fileId);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.once('trash', fileId, (o) =>
          this.files.update({ fileId, requestBody: { trashed: true }, fields: 'id', ...ALL_DRIVES }, o),
        );
        return;
      } catch (err) {
        if (!isRetryable(err) || attempt > this.retries) throw new DriveRequestError('trash', fileId, attempt, err);
        await sleep(this.backoff(attempt));
        // Landed already? Then we're done.
        const file = await this.getMeta('trash', fileId);
        if (!file || file.trashed) return;
      }
    }
  }

  async ensureSubfolders(): Promise<SubfolderIds> {
    const out = {} as SubfolderIds;
    for (const key of SUBFOLDER_KEYS) out[key] = (await this.subfolderId(key, true))!;
    return out;
  }

  async folderOf(fileId: string): Promise<FolderOf> {
    const file = await this.getMeta('folderOf', fileId);
    return file ? this.classify(file) : 'other';
  }

  // ---- request plumbing ----

  private backoff(attempt: number): number {
    return this.backoffMs * 2 ** (attempt - 1);
  }

  /**
   * One attempt with a hard timeout. The timeout is passed to gaxios and an
   * AbortSignal cancels the socket, but the race here is what guarantees the
   * promise settles even if the transport ignores both.
   */
  private once<T>(op: string, target: string, fn: (o: RequestOpts) => Promise<T>): Promise<T> {
    const ms = this.timeoutMs;
    const ctl = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        ctl.abort();
        reject(new DriveTimeoutError(op, target, ms));
      }, ms);
      let p: Promise<T>;
      try {
        p = fn({ timeout: ms, signal: ctl.signal });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** A read-only request: retried on timeout, network error, 429 or 5xx. Other errors pass through unchanged. */
  private async idempotent<T>(op: string, target: string, fn: (o: RequestOpts) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.once(op, target, fn);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        if (attempt > this.retries) throw new DriveRequestError(op, target, attempt, err);
        await sleep(this.backoff(attempt));
      }
    }
  }

  // ---- internals ----

  private async query(op: string, target: string, qs: string): Promise<drive_v3.Schema$File[]> {
    const out: drive_v3.Schema$File[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.idempotent(op, target, (o) =>
        this.files.list(
          {
            q: qs,
            fields: `nextPageToken, files(${FILE_FIELDS})`,
            pageSize: 1000,
            orderBy: 'createdTime',
            includeItemsFromAllDrives: true,
            ...ALL_DRIVES,
            ...(pageToken ? { pageToken } : {}),
          },
          o,
        ),
      );
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
      'findFolder',
      name,
      `${q(this.rootId)} in parents and trashed = false and mimeType = ${q(FOLDER_MIME)} and name = ${q(name)}`,
    );
    let id = found[0]?.id ?? undefined;
    if (!id && create) {
      let data: drive_v3.Schema$File;
      try {
        ({ data } = await this.once('createFolder', name, (o) =>
          this.files.create(
            { requestBody: { name, mimeType: FOLDER_MIME, parents: [this.rootId] }, fields: 'id', ...ALL_DRIVES },
            o,
          ),
        ));
      } catch (err) {
        // Not retried; the next call looks the folder up again first.
        throw new DriveRequestError('createFolder', name, 1, err);
      }
      id = data.id ?? undefined;
      if (!id) throw new Error(`Drive did not return an id for folder ${name}.`);
    }
    if (id) this.subIds[key] = id;
    return id;
  }

  private async getMeta(op: string, fileId: string): Promise<drive_v3.Schema$File | undefined> {
    try {
      const { data } = await this.idempotent(op, fileId, (o) =>
        this.files.get({ fileId, fields: FILE_FIELDS, ...ALL_DRIVES }, o),
      );
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
  private async locate(op: string, fileId: string): Promise<{ file: drive_v3.Schema$File; folder: FolderKey }> {
    const file = await this.getMeta(op, fileId);
    const folder = file ? await this.classify(file) : 'other';
    if (!file || folder === 'other') throw new DriveScopeError(fileId);
    return { file, folder };
  }
}
