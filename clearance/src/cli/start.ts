// npm start: demo step 1. Starts the APPA sidecar, waits for /health, ensures the
// Drive subfolders, then runs the root poller until SIGINT/SIGTERM (exit 0) or until
// the sidecar dies (exit 1). Owned by T7.2.
import { pathToFileURL } from 'node:url';
import { createClassifier } from '../classifier/decide';
import { jevFromConfig } from '../classifier/jev';
import { type Config, getConfig } from '../config';
import { createDriveClient } from '../drive/factory';
import type { DriveClient } from '../drive/types';
import { createDecisionLog } from '../log/decision-log';
import { type ClassifyFn, type ClassifyLogWriter, createPoller } from '../poller/poller';
import { type Sidecar, type SidecarOptions, sidecarOptions, startSidecar } from '../sidecar/runtime';

/** The poller as `main` uses it. */
export interface PollerLike {
  start(): void;
  stop(): Promise<void>;
}

/** Where shutdown signals come from. Default: `process`. */
export interface SignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
  off?(signal: 'SIGINT' | 'SIGTERM', handler: () => void): unknown;
}

export interface StartDeps {
  config?: Config;
  startSidecar?: (opts: SidecarOptions) => Promise<Sidecar>;
  createDrive?: (cfg: Config) => Promise<DriveClient>;
  createClassifier?: (cfg: Config) => ClassifyFn;
  createLog?: () => ClassifyLogWriter;
  createPoller?: (opts: { drive: DriveClient; classify: ClassifyFn; log: ClassifyLogWriter; intervalMs: number; statePath: string }) => PollerLike;
  signals?: SignalSource;
  /** How often to check that the sidecar is still alive. Default 1000 ms. */
  watchMs?: number;
  log?: (msg: string) => void;
  err?: (msg: string) => void;
}

const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs until shutdown. Returns the process exit code. */
export async function main(deps: StartDeps = {}): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const err = deps.err ?? ((m: string) => console.error(m));
  const signals: SignalSource = deps.signals ?? process;

  let cfg: Config;
  let drive: DriveClient;
  try {
    cfg = deps.config ?? getConfig();
    cfg.requireDrive(); // refuses clearly when GDRIVE_ROOT_FOLDER_ID is unset
    drive = await (deps.createDrive ?? ((c: Config) => createDriveClient({ config: c, interactive: false })))(cfg);
  } catch (e) {
    err(message(e));
    return 1;
  }

  let sidecar: Sidecar;
  try {
    sidecar = await (deps.startSidecar ?? startSidecar)(sidecarOptions(cfg));
  } catch (e) {
    err(`could not start the APPA sidecar: ${message(e)}`);
    return 1;
  }
  log(`APPA sidecar healthy at ${sidecar.url}`);

  let poller: PollerLike | undefined;
  let watch: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

  const shutdown = async (code: number): Promise<number> => {
    if (stopping) return code;
    stopping = true;
    if (watch) clearInterval(watch);
    try {
      await poller?.stop();
    } finally {
      await sidecar.stop();
    }
    return code;
  };

  try {
    await drive.ensureSubfolders();
    const classify = (deps.createClassifier ?? ((c: Config) => createClassifier({ jev: jevFromConfig(c) })))(cfg);
    const base = (deps.createLog ?? createDecisionLog)();
    const logWriter: ClassifyLogWriter = {
      writeClassify(line) {
        const written = base.writeClassify(line);
        log(`moved ${line.file} -> ${line.moved ?? line.label} (${line.rule})`);
        return written;
      },
    };
    poller = (deps.createPoller ?? ((o) => createPoller(o)))({
      drive,
      classify,
      log: logWriter,
      intervalMs: cfg.pollIntervalMs,
      statePath: cfg.paths.pollerState,
    });
  } catch (e) {
    err(`startup failed: ${message(e)}`);
    return shutdown(1);
  }

  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      for (const s of SIGNALS) signals.off?.(s, onSignal);
      void shutdown(code)
        .catch((e) => {
          err(`shutdown error: ${message(e)}`);
          return 1;
        })
        .then((c) => resolve(c));
    };
    const onSignal = () => {
      log('stopping poller and sidecar...');
      finish(0);
    };
    for (const s of SIGNALS) signals.once(s, onSignal);

    watch = setInterval(() => {
      if (!sidecar.running()) {
        err('the APPA sidecar exited; stopping.');
        finish(1);
      }
    }, deps.watchMs ?? 1000);

    poller!.start();
    log(`polling every ${cfg.pollIntervalMs / 1000} s (Ctrl-C to stop)`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
