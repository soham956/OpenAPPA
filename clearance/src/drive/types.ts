// DriveClient: the only way Clearance talks to Drive. Implementations are
// scoped to one root folder and its three subfolders (Legal, Accounting,
// High Risk); anything else is "outside the tree" and is refused.

/** A folder inside the Clearance tree. */
export type FolderKey = 'root' | 'legal' | 'accounting' | 'high-risk';
/** The three subfolders under the root. */
export type SubfolderKey = Exclude<FolderKey, 'root'>;
/** Result of `folderOf`: a tree folder, or `other` for anything else. */
export type FolderOf = FolderKey | 'other';

export const FOLDER_KEYS: readonly FolderKey[] = ['root', 'legal', 'accounting', 'high-risk'];
export const SUBFOLDER_KEYS: readonly SubfolderKey[] = ['legal', 'accounting', 'high-risk'];

/** Drive names of the subfolders. */
export const SUBFOLDER_NAMES: Readonly<Record<SubfolderKey, string>> = {
  legal: 'Legal',
  accounting: 'Accounting',
  'high-risk': 'High Risk',
};

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** A (non-folder) file directly inside one of the tree folders. */
export interface DriveFile {
  id: string;
  name: string;
  folder: FolderKey;
}

export interface DriveFileContent {
  id: string;
  name: string;
  /** Text content (plain-text download, or a Google Doc exported as text/plain). */
  content: string;
}

/** Drive ids of the three subfolders. */
export type SubfolderIds = Record<SubfolderKey, string>;

export interface DriveClient {
  /** Drive id of the root folder. */
  readonly rootId: string;
  /** Files (never folders) directly in the root. Same as `list('root')`. */
  listRoot(): Promise<DriveFile[]>;
  /** Files (never folders) directly in `folder`. A missing subfolder lists as []. */
  list(folder: FolderKey): Promise<DriveFile[]>;
  /** Name and text content. Throws DriveScopeError outside the tree. */
  read(fileId: string): Promise<DriveFileContent>;
  /** Move a tree file into `folder` (creating the subfolder if needed). Throws DriveScopeError outside the tree. */
  move(fileId: string, folder: FolderKey): Promise<DriveFile>;
  /** Upload a text file into `folder` (default root). */
  upload(name: string, content: string, folder?: FolderKey): Promise<DriveFile>;
  /** Move a tree file to the Drive trash. Throws DriveScopeError outside the tree. */
  trash(fileId: string): Promise<void>;
  /** Create any missing subfolder under the root; idempotent. Returns their ids. */
  ensureSubfolders(): Promise<SubfolderIds>;
  /**
   * Which tree folder holds the file right now (never cached, so a file a
   * person moves out of High Risk is seen at once). `other` for folders,
   * trashed or unknown ids, and anything outside the tree.
   */
  folderOf(fileId: string): Promise<FolderOf>;
}

/** Thrown when an operation names a file outside the Clearance tree. */
export class DriveScopeError extends Error {
  constructor(
    readonly fileId: string,
    detail = 'is not a file in the Clearance folder tree',
  ) {
    super(`Drive file ${fileId} ${detail}.`);
    this.name = 'DriveScopeError';
  }
}

export function isFolderKey(v: unknown): v is FolderKey {
  return typeof v === 'string' && (FOLDER_KEYS as readonly string[]).includes(v);
}
