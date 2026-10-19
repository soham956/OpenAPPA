// npm run agent -- "<task>": demo step 2, against the sidecar `npm start` runs.
import { pathToFileURL } from 'node:url';
import { runScript, type AgentGuard, type LegalFile } from '../agent/script';
import { type Config, getConfig } from '../config';
import { createDriveClient } from '../drive/factory';
import type { DriveClient } from '../drive/types';
import { DecisionLog } from '../log/decision-log';
import { Guard } from '../sidecar/guard';
import { McpRemedyClient } from '../sidecar/remedy';
import { LOOPBACK, waitForHealth } from '../sidecar/runtime';
import { HookClient } from '../sidecar/wire';
import { driveList, driveRead } from '../tools/drive';

export const DEFAULT_TASK = 'check the legal documents and send them to the legal team';

export interface BuiltGuard {
  guard: AgentGuard;
  close(): Promise<void>;
}

/** The real guard: hook + MCP remedy at the sidecar, the real Drive tools, the decision log. */
export function buildGuard(cfg: Config, drive: DriveClient, baseUrl: string): BuiltGuard {
  const remedy = new McpRemedyClient(baseUrl);
  const guard = new Guard({
    hook: new HookClient({ baseUrl }),
    remedy,
    drive,
    log: new DecisionLog({ path: cfg.paths.decisionsLog }),
    outboxPath: cfg.paths.outboxLog,
    memoryPath: cfg.paths.memoryFile,
    tools: {
      drive_list: (args, ctx) => driveList(ctx.drive, args),
      drive_read: (args, ctx) => driveRead(ctx.drive, args),
    },
  });
  return { guard, close: () => remedy.close() };
}

export interface AgentCliDeps {
  config?: Config;
  createDrive?: (cfg: Config) => Promise<DriveClient>;
  /** Builds the guard (tests pass a stub). */
  makeGuard?: (cfg: Config, drive: DriveClient, baseUrl: string) => BuiltGuard;
  /** Resolves when the sidecar is healthy (tests pass a no-op). */
  checkSidecar?: (baseUrl: string) => Promise<void>;
  print?: (line: string) => void;
}

/** Returns the process exit code: 0 when the script ran to the end with no `error` decision. */
export async function main(argv: readonly string[], deps: AgentCliDeps = {}): Promise<number> {
  const print = deps.print ?? ((l: string) => console.log(l));
  try {
    const task = argv.join(' ').trim() || DEFAULT_TASK;
    const cfg = deps.config ?? getConfig();
    const baseUrl = `http://${LOOPBACK}:${cfg.appaPort}`;
    try {
      await (deps.checkSidecar ?? ((u) => waitForHealth(u, 2000)))(baseUrl);
    } catch {
      throw new Error(`The appa sidecar is not answering at ${baseUrl}/health. Run \`npm start\` in another terminal first.`);
    }
    const drive = await (deps.createDrive ?? ((config) => createDriveClient({ config })))(cfg);
    const { guard, close } = (deps.makeGuard ?? buildGuard)(cfg, drive, baseUrl);
    const listLegal = async (): Promise<LegalFile[]> => (await drive.list('legal')).map((f) => ({ id: f.id, name: f.name }));
    const res = await runScript(task, { guard, listLegal, print }).finally(() => close().catch(() => {}));
    if (res.aborted) return 1;
    return res.steps.some((s) => s.decision === 'error') ? 1 : 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
