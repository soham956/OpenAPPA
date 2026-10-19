// Sidecar launcher: runs `appa runtime --adapter amp` on loopback and waits for /health.
// The runtime is the only policy authority; this module only starts and stops it.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';

export interface SidecarOptions {
  /** The `appa` binary. */
  bin: string;
  /** The policy file (clearance/appa.toml). */
  config: string;
  /** The runtime's SQLite store (state/appa.db, or a temp file in tests). */
  db: string;
  /** TCP port on 127.0.0.1. 0 takes a free port. */
  port: number;
  /** How long to wait for the URL line and a healthy /health. Default 20 s. */
  startTimeoutMs?: number;
  /** How long `stop()` waits after SIGTERM before SIGKILL. Default 5 s. */
  stopTimeoutMs?: number;
  /** Environment for the runtime. Default: process.env (it needs `node` on PATH for the rcpt source). */
  env?: NodeJS.ProcessEnv;
}

export interface Sidecar {
  /** Base URL, e.g. http://127.0.0.1:8790 (no trailing slash). */
  readonly url: string;
  readonly pid: number | undefined;
  /** Whether the process is still running. */
  running(): boolean;
  /** Terminate the runtime and wait for it to exit. Idempotent. */
  stop(): Promise<void>;
}

export class SidecarStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarStartError';
  }
}

export const LOOPBACK = '127.0.0.1';

/** The production options: APPA_BIN, clearance/appa.toml, state/appa.db, APPA_PORT. */
export function sidecarOptions(cfg: Pick<Config, 'appaBin' | 'appaPort' | 'paths'>): SidecarOptions {
  return { bin: cfg.appaBin, config: cfg.paths.appaConfig, db: cfg.paths.appaDb, port: cfg.appaPort };
}

/** The argv the launcher runs, without the binary. Exported for tests. */
export function runtimeArgs(opts: Pick<SidecarOptions, 'config' | 'db' | 'port'>): string[] {
  return ['runtime', '--adapter', 'amp', '--listen', `${LOOPBACK}:${opts.port}`, '--config', opts.config, '--db', opts.db];
}

/** Resolve once GET <url>/health answers 200, or reject when the deadline passes. */
export async function waitForHealth(url: string, timeoutMs: number, alive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no answer';
  while (Date.now() < deadline) {
    if (!alive()) throw new SidecarStartError('appa runtime exited before /health answered');
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new SidecarStartError(`appa runtime /health did not answer within ${timeoutMs} ms (${last})`);
}

/**
 * Start `appa runtime --adapter amp --listen 127.0.0.1:<port> --config <config> --db <db>`.
 * Resolves when the runtime has printed the URL it serves and /health answers. Rejects (and
 * kills the process) if it exits, prints no URL, or stays unhealthy past the timeout.
 */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  const stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;
  mkdirSync(dirname(opts.db), { recursive: true });

  const child = spawn(opts.bin, runtimeArgs(opts), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts.env ?? process.env,
  });
  let exited = false;
  let stderrTail = '';
  const exitedPromise = new Promise<void>((resolve) => {
    const done = () => {
      exited = true;
      resolve();
    };
    child.once('exit', done);
    // A spawn failure (e.g. ENOENT) emits 'error' and never 'exit'.
    child.once('error', () => {
      if (child.pid === undefined) done();
    });
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!exited) child.kill('SIGKILL');
    }, stopTimeoutMs);
    await exitedPromise;
    clearTimeout(timer);
  };

  try {
    const started = Date.now();
    const url = await readUrlLine(child, startTimeoutMs);
    // Keep draining stdout so the runtime can never block on a full pipe.
    child.stdout?.resume();
    await waitForHealth(url, Math.max(1000, startTimeoutMs - (Date.now() - started)), () => !exited);
    return {
      url,
      pid: child.pid,
      running: () => !exited,
      stop,
    };
  } catch (error) {
    await stop();
    const detail = stderrTail.trim() ? `\n${stripAnsi(stderrTail.trim())}` : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new SidecarStartError(`${message}${detail}`);
  }
}

/** The runtime prints the URL it serves as its one stdout line once it listens. */
function readUrlLine(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new SidecarStartError(`appa runtime printed no URL within ${timeoutMs} ms`)), timeoutMs);
    const onData = (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const url = new URL(line);
        if (url.hostname !== LOOPBACK) throw new Error(`not loopback: ${line}`);
        finish(undefined, line.replace(/\/$/, ''));
      } catch {
        finish(new SidecarStartError(`appa runtime printed an unexpected first line: ${line}`));
      }
    };
    const onExit = (code: number | null, signal: string | null) =>
      finish(new SidecarStartError(`appa runtime exited (code ${code}, signal ${signal}) before listening`));
    const onError = (error: Error) => finish(new SidecarStartError(`appa runtime could not start: ${error.message}`));
    function finish(error?: Error, url?: string) {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(url as string);
    }
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}
