import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  COMPANION_DIR_PREFIX,
  COMPANION_OWNER_FILE,
  COMPANION_ROOT,
  COMPANION_SOCKET,
  sweepStaleCompanionDirsOnce,
} from './idb-companion-sweep.js';
import type { CompanionOwner } from './idb-companion-sweep.js';
import { exec } from '../utils/exec.js';
import { stopChildProcess } from '../utils/stop-child-process.js';

const START_TIMEOUT_MS = 10_000;

/**
 * The companion exits after this many seconds without gRPC requests, so an
 * orphan (owner killed with SIGKILL) does not live forever. The backend
 * reconnects transparently on the next call when the companion is gone.
 */
export const COMPANION_IDLE_SHUTDOWN_SECONDS = 3600;

/** A private companion. Never registers or disconnects a shared UDID mapping. */
export class IdbConnection {
  #child: ChildProcess | undefined;

  #directory: string | undefined;

  #socket: string | undefined;

  #alive = false;

  readonly #udid: string;

  constructor(udid: string) {
    this.#udid = udid;
  }

  /**
   * Whether the companion child is running. Becomes false when the child
   * exits for any reason after readiness (crash, simulator shutdown with
   * `--terminate-offline`, idle shutdown, external kill).
   *
   * @returns True while the private companion can serve requests.
   */
  get alive(): boolean {
    return this.#alive;
  }

  get env(): NodeJS.ProcessEnv {
    if (!this.#socket) {
      throw new Error('IDB companion is not connected');
    }
    return { ...process.env, IDB_COMPANION: this.#socket };
  }

  async connect(idbPath: string): Promise<void> {
    const candidates = [
      join(dirname(idbPath), 'idb_companion'),
      'idb_companion',
      '/opt/homebrew/bin/idb_companion',
      '/usr/local/bin/idb_companion',
    ];
    let executable: string | undefined;
    for (const candidate of new Set(candidates)) {
      const probe = await exec(candidate, ['--version']).catch(() => null);
      if (probe?.exitCode === 0) {
        executable = candidate;
        break;
      }
    }
    if (!executable) {
      throw new Error(
        'idb_companion not found. Install it with brew install idb-companion.',
      );
    }

    // Remove directories left by device-mcp processes that died without
    // disposal. Runs once per process; never touches shared companions.
    await sweepStaleCompanionDirsOnce();

    // macOS Unix sockets have a short path limit; the normal TMPDIR can be too long.
    this.#directory = await mkdtemp(join(COMPANION_ROOT, COMPANION_DIR_PREFIX));
    const directory = this.#directory;
    await this.#writeOwner(directory);
    this.#socket = join(directory, COMPANION_SOCKET);
    const socket = this.#socket;
    const child = spawn(
      executable,
      [
        '--udid',
        this.#udid,
        '--grpc-domain-sock',
        socket,
        // Exit when the simulator shuts down (its HID connection is gone for
        // good); the backend then starts a fresh companion on the next call.
        '--terminate-offline',
        'true',
        '--idle-shutdown-time',
        String(COMPANION_IDLE_SHUTDOWN_SECONDS),
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.#child = child;
    // Permanent listener: a companion that dies after readiness must be
    // noticed, or every later call fails on a dead socket.
    child.once('exit', () => {
      if (this.#child === child) {
        this.#alive = false;
      }
    });

    await new Promise<void>((resolve, reject) => {
      let output = '';
      let stderr = '';
      const timer = setTimeout(
        () => finish(new Error('Timed out starting private IDB companion')),
        START_TIMEOUT_MS,
      );
      const onError = (error: Error): void => finish(error);
      const onExit = (code: number | null): void =>
        finish(
          new Error(
            `Private IDB companion exited before readiness (${code}): ${stderr}`,
          ),
        );
      const onStderr = (data: Buffer): void => {
        stderr = (stderr + data.toString()).slice(-4096);
      };
      const onData = (data: Buffer): void => {
        output += data.toString();
        if (output.length > 65_536) {
          finish(new Error('Invalid IDB companion readiness report'));
          return;
        }
        const newline = output.indexOf('\n');
        if (newline < 0) {
          return;
        }
        try {
          const report = JSON.parse(output.slice(0, newline)) as Record<
            string,
            unknown
          >;
          finish(
            report.grpc_path === socket
              ? undefined
              : new Error('IDB companion reported an unexpected socket'),
          );
        } catch (error) {
          finish(error as Error);
        }
      };
      function finish(error?: Error): void {
        clearTimeout(timer);
        child.off('error', onError);
        child.off('exit', onExit);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onStderr);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onStderr);
    });
    // Keep draining output so a chatty companion cannot block on a full pipe.
    child.stdout?.resume();
    child.stderr?.resume();
    this.#alive = child.exitCode === null && child.signalCode === null;
    await this.#writeOwner(directory, child.pid);
  }

  async #writeOwner(directory: string, companionPid?: number): Promise<void> {
    const owner: CompanionOwner = { ownerPid: process.pid, companionPid };
    // Best effort: the sweep treats a directory without a record as unknown
    // and leaves it alone for a grace period.
    await writeFile(
      join(directory, COMPANION_OWNER_FILE),
      JSON.stringify(owner),
      {
        mode: 0o600,
      },
    ).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.#alive = false;
    const child = this.#child;
    if (child) {
      await stopChildProcess(child);
    }
    this.#child = undefined;
    if (this.#directory) {
      await rm(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
    }
    this.#socket = undefined;
  }
}
