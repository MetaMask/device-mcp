import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepStaleCompanionDirs } from './idb-companion-sweep.js';

const DEAD_PID = 2 ** 22 + 12_345;

describe('sweepStaleCompanionDirs', () => {
  let root: string;
  const servers: Server[] = [];
  const children: ChildProcess[] = [];

  beforeEach(async () => {
    // A short root so the Unix socket paths stay under the macOS limit.
    root = await mkdtemp(join('/tmp', 'dmcp-sweep-'));
  });

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map(
          async (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    );
    for (const child of children.splice(0)) {
      child.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  });

  async function makeDir(
    name: string,
    owner?: Record<string, unknown>,
    ageMs = 120_000,
  ): Promise<string> {
    const directory = join(root, name);
    await mkdir(directory);
    if (owner) {
      await writeFile(join(directory, 'owner.json'), JSON.stringify(owner));
    }
    const time = (Date.now() - ageMs) / 1000;
    await utimes(directory, time, time);
    return directory;
  }

  async function listen(directory: string): Promise<void> {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(join(directory, 'companion.sock'), resolve),
    );
  }

  it('removes only directories whose owner is gone and whose socket is dead', async () => {
    await makeDir('device-mcp-idb-dead', { ownerPid: DEAD_PID });
    await makeDir('device-mcp-idb-live-owner', { ownerPid: process.pid });
    const listening = await makeDir('device-mcp-idb-listening', {
      ownerPid: DEAD_PID,
    });
    await listen(listening);
    await makeDir('device-mcp-idb-unowned-old');
    await makeDir('device-mcp-idb-unowned-new', undefined, 0);
    await makeDir('idb');
    await makeDir('something-else', { ownerPid: DEAD_PID });

    const removed = await sweepStaleCompanionDirs({ root });

    expect(removed.sort()).toStrictEqual(
      [
        join(root, 'device-mcp-idb-dead'),
        join(root, 'device-mcp-idb-unowned-old'),
      ].sort(),
    );
    expect((await readdir(root)).sort()).toStrictEqual(
      [
        'device-mcp-idb-listening',
        'device-mcp-idb-live-owner',
        'device-mcp-idb-unowned-new',
        'idb',
        'something-else',
      ].sort(),
    );
  });

  it('stops an orphaned companion only when it provably owns the directory socket', async () => {
    const directory = await makeDir('device-mcp-idb-orphan', {
      ownerPid: DEAD_PID,
      companionPid: 4242,
    });
    const terminate = vi.fn().mockResolvedValue(true);
    const ownsSocket = vi.fn().mockResolvedValue(true);

    const removed = await sweepStaleCompanionDirs({
      root,
      isAlive: (pid) => pid === 4242,
      ownsSocket,
      terminate,
      socketAccepts: async () => false,
    });

    expect(ownsSocket).toHaveBeenCalledWith(
      4242,
      join(directory, 'companion.sock'),
    );
    expect(terminate).toHaveBeenCalledWith(4242);
    expect(removed).toStrictEqual([directory]);
  });

  it('never signals a reused pid and keeps the directory while its socket answers', async () => {
    await makeDir('device-mcp-idb-reused', {
      ownerPid: DEAD_PID,
      companionPid: 4242,
    });
    const terminate = vi.fn();

    const removed = await sweepStaleCompanionDirs({
      root,
      isAlive: (pid) => pid === 4242,
      ownsSocket: async () => false,
      terminate,
      socketAccepts: async () => true,
    });

    expect(terminate).not.toHaveBeenCalled();
    expect(removed).toStrictEqual([]);
  });

  it('keeps the directory when its companion does not stop', async () => {
    await makeDir('device-mcp-idb-stuck', {
      ownerPid: DEAD_PID,
      companionPid: 4242,
    });

    const removed = await sweepStaleCompanionDirs({
      root,
      isAlive: (pid) => pid === 4242,
      ownsSocket: async () => true,
      terminate: async () => false,
      socketAccepts: async () => false,
    });

    expect(removed).toStrictEqual([]);
  });

  it('ignores a malformed owner record like a missing one', async () => {
    const directory = await makeDir('device-mcp-idb-bad');
    await writeFile(join(directory, 'owner.json'), '{"ownerPid":"x"');
    const old = (Date.now() - 120_000) / 1000;
    await utimes(directory, old, old);
    expect(await sweepStaleCompanionDirs({ root })).toStrictEqual([directory]);
    expect(await sweepStaleCompanionDirs({ root, now: () => 0 })).toStrictEqual(
      [],
    );
  });

  it('skips non-directories and a missing root', async () => {
    await writeFile(join(root, 'device-mcp-idb-file'), '');
    expect(await sweepStaleCompanionDirs({ root })).toStrictEqual([]);
    expect(
      await sweepStaleCompanionDirs({ root: join(root, 'missing') }),
    ).toStrictEqual([]);
  });

  it('uses real pid, socket and ps probes by default', async () => {
    // A real process that names the directory socket in its command line,
    // standing in for an orphaned companion.
    const directory = await makeDir('device-mcp-idb-real');
    const socket = join(directory, 'companion.sock');
    const child = spawn(
      process.execPath,
      [
        '-e',
        'setInterval(() => {}, 1000)',
        'idb_companion',
        '--grpc-domain-sock',
        socket,
      ],
      { stdio: 'ignore' },
    );
    children.push(child);
    await writeFile(
      join(directory, 'owner.json'),
      JSON.stringify({ ownerPid: DEAD_PID, companionPid: child.pid }),
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));

    const removed = await sweepStaleCompanionDirs({ root });

    expect(removed).toStrictEqual([directory]);
    await exited;
  }, 10_000);

  it('does not treat an unrelated live process as the companion', async () => {
    const directory = await makeDir('device-mcp-idb-unrelated', {
      ownerPid: DEAD_PID,
      companionPid: process.pid,
    });
    // process.pid is alive but is not an idb_companion for this socket, and
    // the socket is dead: the directory goes, the process is not signalled.
    const removed = await sweepStaleCompanionDirs({ root });
    expect(removed).toStrictEqual([directory]);
  });
});

describe('sweepStaleCompanionDirsOnce', () => {
  it('runs the sweep at most once per process and never rejects', async () => {
    vi.resetModules();
    const { sweepStaleCompanionDirsOnce } =
      await import('./idb-companion-sweep.js');
    const sweep = vi.fn().mockRejectedValue(new Error('EACCES'));
    await Promise.all([
      sweepStaleCompanionDirsOnce(sweep),
      sweepStaleCompanionDirsOnce(sweep),
    ]);
    expect(await sweepStaleCompanionDirsOnce(sweep)).toBeUndefined();
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
