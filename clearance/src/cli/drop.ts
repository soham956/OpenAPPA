// npm run drop: demo step 3 (upload seed/new/11-* to the Drive root).
import { pathToFileURL } from 'node:url';
import { type Config, getConfig } from '../config';
import { type DriveFactory, drop, liveDriveFactory } from '../reset/reset';

const createDrive: DriveFactory = liveDriveFactory;

export interface DropCliDeps {
  config?: Config;
  createDrive?: DriveFactory;
  log?: (msg: string) => void;
}

/** Returns the process exit code. */
export async function main(deps: DropCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const cfg = deps.config ?? getConfig();
    cfg.requireDrive();
    const drive = await (deps.createDrive ?? createDrive)(cfg);
    for (const f of await drop({ drive, paths: cfg.paths })) log(`uploaded ${f.name} to the Drive root`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
