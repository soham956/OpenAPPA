// Build the live DriveClient from config. GDRIVE_AUTH picks the auth mode;
// nothing else changes. Tests inject a FakeDriveClient instead of calling this.
import { google } from 'googleapis';
import { type Config, getConfig } from '../config';
import { type AuthOptions, type DriveAuth, getDriveAuth } from './auth';
import { DEFAULT_TIMEOUT_MS, GoogleDriveClient } from './google';
import type { DriveClient } from './types';

export interface CreateDriveOptions extends AuthOptions {
  /** Config to use (default: getConfig()). */
  config?: Config;
  /** Auth builder (default: getDriveAuth). Test seam. */
  authFactory?: typeof getDriveAuth;
  /** Per-request Drive timeout in ms (default DEFAULT_TIMEOUT_MS, 20 s). */
  timeoutMs?: number;
  /** Retries for retryable Drive failures (default 2). */
  retries?: number;
}

/**
 * The Google-backed DriveClient for GDRIVE_ROOT_FOLDER_ID. Throws ConfigError
 * when the folder id, the client JSON / key or (non-interactive) the cached
 * OAuth token is missing. Makes no network call itself.
 */
export async function createDriveClient(opts: CreateDriveOptions = {}): Promise<DriveClient> {
  const cfg = opts.config ?? getConfig();
  const drive = cfg.requireDrive();
  const auth: DriveAuth = await (opts.authFactory ?? getDriveAuth)(drive, opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // gaxios gets the timeout too (it aborts the socket); GoogleDriveClient also
  // enforces it per request, so a hung call always rejects.
  return new GoogleDriveClient(google.drive({ version: 'v3', auth, timeout: timeoutMs }), drive.rootFolderId, {
    timeoutMs,
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
  });
}
