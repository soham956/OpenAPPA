// Helpers for the step 2 end-to-end test: one run = a fresh temp root, a fresh appa
// runtime DB, a fake Drive seeded with 01–10 already classified, and the real agent CLI.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/agent';
import { CLEARANCE_DIR, type Config, loadConfig } from '../../src/config';
import { FakeDriveClient } from '../../src/drive/fake';
import type { FolderKey } from '../../src/drive/types';
import { type Sidecar, startSidecar } from '../../src/sidecar/runtime';

const truthy = (v: string | undefined) => ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());
export const APPA_BIN = process.env.APPA_BIN?.trim();
export const REQUIRED = truthy(process.env.CLEARANCE_REQUIRE_APPA);
/** Skip only when APPA_BIN is absent AND CLEARANCE_REQUIRE_APPA is unset (CI sets both). */
export const LIVE = Boolean(APPA_BIN) || REQUIRED;

export const SEED_DIR = join(CLEARANCE_DIR, 'seed');
export const EXPECTED_FILE = join(CLEARANCE_DIR, 'expected-decisions.json');

/** Where each seed sits after step 1 (docs/demo-script.md). */
export const CLASSIFIED: Readonly<Record<string, FolderKey>> = {
  '01-mutual-nda-kestrel-orbit.txt': 'legal',
  '02-master-services-agreement.txt': 'legal',
  '03-cease-and-desist-letter.txt': 'legal',
  '04-board-resolution-oct.txt': 'legal',
  '05-invoice-0193.txt': 'accounting',
  '06-q3-expense-report.txt': 'accounting',
  '07-trial-balance-sept.txt': 'accounting',
  '08-employment-contract-r-okafor.txt': 'high-risk',
  '09-payslip-sept-m-lindqvist.txt': 'high-risk',
  '10-settlement-payment-schedule.txt': 'high-risk',
};

/** A fake Drive in the post-step-1 state: subfolders exist, root empty, 01–10 filed. */
export async function classifiedDrive(): Promise<FakeDriveClient> {
  const drive = new FakeDriveClient();
  await drive.ensureSubfolders();
  for (const [name, folder] of Object.entries(CLASSIFIED)) {
    await drive.upload(name, readFileSync(join(SEED_DIR, name), 'utf8'), folder);
  }
  return drive;
}

export interface Step2Run {
  /** Temp repo root of this run. */
  root: string;
  config: Config;
  /** logs/ of this run (decisions.jsonl, outbox.jsonl). */
  logsDir: string;
  drive: FakeDriveClient;
  exitCode: number;
  printed: string[];
  /** The sidecar's pid, so the test can check it is gone. */
  pid: number | undefined;
}

/**
 * Start the real `appa runtime` on a free loopback port with a fresh temp DB and
 * clearance/appa.toml, run `npm run agent`'s main() against a classified fake Drive,
 * then stop the runtime (always).
 */
export async function runStep2(): Promise<Step2Run> {
  const root = mkdtempSync(join(tmpdir(), 'clearance-e2e-'));
  const sidecar: Sidecar = await startSidecar({
    bin: APPA_BIN || 'appa',
    config: join(CLEARANCE_DIR, 'appa.toml'),
    db: join(root, 'state', 'appa.db'),
    port: 0,
  });
  try {
    const port = new URL(sidecar.url).port;
    // Synthetic env only; the temp root has no .env and no secrets/.
    const config = loadConfig({ repoRoot: root, env: { GDRIVE_ROOT_FOLDER_ID: 'fake-root', APPA_PORT: port } });
    const drive = await classifiedDrive();
    const printed: string[] = [];
    const exitCode = await main([], { config, createDrive: async () => drive, print: (l) => printed.push(l) });
    return { root, config, logsDir: config.paths.logsDir, drive, exitCode, printed, pid: sidecar.pid };
  } finally {
    await sidecar.stop();
  }
}

/** The expected file with its classify section emptied (classify is step 1, not step 2). */
export function step2ExpectedFile(dir: string): string {
  const expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')) as Record<string, unknown>;
  const path = join(dir, 'expected-step2.json');
  writeFileSync(path, JSON.stringify({ ...expected, classify: [] }, null, 2));
  return path;
}

/** True while a process with this pid exists. */
export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
