// npm run reset: demo step 0.
import { pathToFileURL } from 'node:url';
import { type Config, getConfig } from '../config';
import { type DriveFactory, notWiredDriveFactory, reset, sidecarUrlFor } from '../reset/reset';

// TODO(T3.2): replace with the real factory from src/drive/factory.ts.
const createDrive: DriveFactory = notWiredDriveFactory;

export interface ResetCliDeps {
  config?: Config;
  createDrive?: DriveFactory;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** Returns the process exit code. */
export async function main(deps: ResetCliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const cfg = deps.config ?? getConfig();
    cfg.requireDrive();
    const drive = await (deps.createDrive ?? createDrive)(cfg);
    await reset({ drive, paths: cfg.paths, sidecarUrl: sidecarUrlFor(cfg), fetchImpl: deps.fetchImpl, log });
    log('reset done: Drive root holds 01–10; Legal, Accounting and High Risk are empty.');
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
