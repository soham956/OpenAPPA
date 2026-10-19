// npm run drive:check: list the Drive root and ensure Legal/, Accounting/ and
// High Risk/ exist. With GDRIVE_AUTH=oauth and no cached token, this is the
// one command that opens the browser for consent.
import { pathToFileURL } from 'node:url';
import { ConfigError } from '../config';
import { createDriveClient } from '../drive/factory';
import { type DriveClient, SUBFOLDER_KEYS, SUBFOLDER_NAMES, type SubfolderIds } from '../drive/types';

export interface DriveCheckResult {
  rootFiles: string[];
  subfolders: SubfolderIds;
}

export async function driveCheck(client: DriveClient, log: (line: string) => void = console.log): Promise<DriveCheckResult> {
  const root = await client.listRoot();
  const rootFiles = root.map((f) => f.name).sort();
  log(`Drive root ${client.rootId}: ${rootFiles.length} file(s)`);
  for (const name of rootFiles) log(`  ${name}`);
  const subfolders = await client.ensureSubfolders();
  for (const key of SUBFOLDER_KEYS) log(`  ${SUBFOLDER_NAMES[key]}/  ${subfolders[key]}`);
  log('drive:check OK');
  return { rootFiles, subfolders };
}

async function main(): Promise<void> {
  try {
    await driveCheck(await createDriveClient({ interactive: true }));
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : `drive:check failed: ${(err as Error).message ?? err}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
