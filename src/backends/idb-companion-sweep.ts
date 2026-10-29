import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import { exec } from '../utils/exec.js';

/** Parent directory of the private companion directories (short socket paths). */
export const COMPANION_ROOT = '/tmp';

/** Prefix of every private companion directory created by `IdbConnection`. */
export const COMPANION_DIR_PREFIX = 'device-mcp-idb-';

/** Socket file name inside a private companion directory. */
export const COMPANION_SOCKET = 'companion.sock';

/** Ownership record inside a private companion directory. */
export const COMPANION_OWNER_FILE = 'owner.json';

/**
 * Directories without an ownership record (created by an older device-mcp, or
 * by a process that has not written it yet) are left alone for this long.
 */
const UNOWNED_GRACE_MS = 60_000;

const SOCKET_PROBE_TIMEOUT_MS = 1_000;

const TERMINATE_WAIT_MS = 2_000;

export type CompanionOwner = {
  /** The process that owns the directory (the device-mcp host process). */
  ownerPid: number;
  /** The private companion child, once spawned. */
  companionPid?: number;
};

export type SweepDependencies = {
  root: string;
  now: () => number;
  isAlive: (pid: number) => boolean;
  socketAccepts: (socket: string) => Promise<boolean>;
  ownsSocket: (pid: number, socket: string) => Promise<boolean>;
  terminate: (pid: number) => Promise<boolean>;
};

/**
 * Remove private companion directories left behind by a device-mcp process
 * that died without disposal (for example SIGKILL).
 *
 * A directory is removed only when nobody can still use it:
 * - its recorded owner process is gone (a live owner is never touched), and
 * - its socket does not accept a connection.
 *
 * A companion child is stopped only when its owner is gone and its command
 * line names this directory's socket (proof that it belongs to the
 * directory). Shared companions (`/tmp/idb/...`) never match the prefix and
 * are never touched.
 *
 * @param overrides - Test seams; defaults inspect the real system.
 * @returns The directories that were removed.
 */
export async function sweepStaleCompanionDirs(
  overrides: Partial<SweepDependencies> = {},
): Promise<string[]> {
  const deps: SweepDependencies = { ...defaultDependencies(), ...overrides };
  const entries = await readdir(deps.root).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(COMPANION_DIR_PREFIX)) {
      continue;
    }
    const directory = join(deps.root, entry);
    try {
      if (await isStale(directory, deps)) {
        await rm(directory, { recursive: true, force: true });
        removed.push(directory);
      }
    } catch {
      // Another user's directory, or a race with its owner: leave it.
    }
  }
  return removed;
}

async function isStale(
  directory: string,
  deps: SweepDependencies,
): Promise<boolean> {
  const stats = await lstat(directory);
  if (
    !stats.isDirectory() ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid())
  ) {
    return false;
  }
  const owner = await readOwner(directory);
  if (owner && deps.isAlive(owner.ownerPid)) {
    return false;
  }
  if (!owner && deps.now() - stats.mtimeMs < UNOWNED_GRACE_MS) {
    return false;
  }
  const socket = join(directory, COMPANION_SOCKET);
  if (owner?.companionPid !== undefined && deps.isAlive(owner.companionPid)) {
    if (!(await deps.ownsSocket(owner.companionPid, socket))) {
      // The pid was reused by an unrelated process. Fall through to the
      // socket probe; never signal that process.
    } else if (!(await deps.terminate(owner.companionPid))) {
      return false;
    }
  }
  return !(await deps.socketAccepts(socket));
}

async function readOwner(
  directory: string,
): Promise<CompanionOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(directory, COMPANION_OWNER_FILE), 'utf8'),
    ) as Partial<CompanionOwner>;
    if (typeof parsed.ownerPid !== 'number') {
      return undefined;
    }
    return {
      ownerPid: parsed.ownerPid,
      companionPid:
        typeof parsed.companionPid === 'number'
          ? parsed.companionPid
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function socketAccepts(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const connection = createConnection(socket);
    const timer = setTimeout(() => done(false), SOCKET_PROBE_TIMEOUT_MS);
    function done(accepted: boolean): void {
      clearTimeout(timer);
      connection.destroy();
      resolve(accepted);
    }
    connection.once('connect', () => done(true));
    connection.once('error', () => done(false));
  });
}

async function ownsSocket(pid: number, socket: string): Promise<boolean> {
  const result = await exec('ps', ['-o', 'command=', '-p', String(pid)]).catch(
    () => null,
  );
  const command = result?.exitCode === 0 ? result.stdout : '';
  return (
    command.includes('idb_companion') &&
    command.includes(`--grpc-domain-sock ${socket}`)
  );
}

async function terminate(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isAlive(pid);
  }
  const deadline = Date.now() + TERMINATE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

function defaultDependencies(): SweepDependencies {
  return {
    root: COMPANION_ROOT,
    now: () => Date.now(),
    isAlive,
    socketAccepts,
    ownsSocket,
    terminate,
  };
}

let sweeping: Promise<void> | undefined;

/**
 * Run the sweep once per process, before the first private companion starts.
 * Failures are ignored: a leftover directory must never block a session.
 *
 * @param sweep - The sweep to run (test seam).
 * @returns A promise that settles when the sweep has finished.
 */
export async function sweepStaleCompanionDirsOnce(
  sweep: () => Promise<unknown> = sweepStaleCompanionDirs,
): Promise<void> {
  sweeping ??= sweep().then(
    () => undefined,
    () => undefined,
  );
  return sweeping;
}
