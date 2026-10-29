import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sweepStaleCompanionDirsOnce } from './idb-companion-sweep.js';
import { IdbConnection } from './idb-connection.js';
import { exec } from '../utils/exec.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('../utils/exec.js', () => ({ exec: vi.fn() }));
vi.mock('./idb-companion-sweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./idb-companion-sweep.js')>()),
  sweepStaleCompanionDirsOnce: vi.fn(),
}));

function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
      return true;
    }),
  });
  return child;
}

describe('IdbConnection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    vi.mocked(rm).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(sweepStaleCompanionDirsOnce).mockResolvedValue(undefined);
    let counter = 0;
    vi.mocked(mkdtemp).mockImplementation(async () => {
      counter += 1;
      return `/tmp/device-mcp-idb-${counter}`;
    });
    vi.mocked(spawn).mockImplementation((_command, args) => {
      const child = childProcess();
      queueMicrotask(() =>
        child.stdout.write(`${JSON.stringify({ grpc_path: args?.[3] })}\n`),
      );
      return child as unknown as ReturnType<typeof spawn>;
    });
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['sim-a', 'sim-b'],
    ['same-sim', 'same-sim'],
  ])('isolates companions for %s / %s', async (a, b) => {
    const first = new IdbConnection(a);
    const second = new IdbConnection(b);
    await Promise.all([
      first.connect('/opt/homebrew/bin/idb'),
      second.connect('/opt/homebrew/bin/idb'),
    ]);
    const firstChild = vi.mocked(spawn).mock.results[0].value;
    const secondChild = vi.mocked(spawn).mock.results[1].value;
    expect(first.env.IDB_COMPANION).not.toBe(second.env.IDB_COMPANION);
    await first.dispose();
    await first.dispose();
    expect(firstChild.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(secondChild.kill).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['disconnect']),
    );
    expect(rm).toHaveBeenCalledExactlyOnceWith('/tmp/device-mcp-idb-1', {
      recursive: true,
      force: true,
    });
    await second.dispose();
  });

  it('starts the companion with lifetime flags so orphans exit on their own', async () => {
    const connection = new IdbConnection('sim-a');
    await connection.connect('/opt/homebrew/bin/idb');
    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args).toStrictEqual([
      '--udid',
      'sim-a',
      '--grpc-domain-sock',
      '/tmp/device-mcp-idb-1/companion.sock',
      '--terminate-offline',
      'true',
      '--idle-shutdown-time',
      '3600',
    ]);
    expect(sweepStaleCompanionDirsOnce).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(sweepStaleCompanionDirsOnce).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(mkdtemp).mock.invocationCallOrder[0]);
    await connection.dispose();
  });

  it('records the owner and companion pids in the private directory', async () => {
    const connection = new IdbConnection('sim-a');
    await connection.connect('idb');
    expect(writeFile).toHaveBeenLastCalledWith(
      '/tmp/device-mcp-idb-1/owner.json',
      JSON.stringify({ ownerPid: process.pid, companionPid: 123 }),
      { mode: 0o600 },
    );
    await connection.dispose();
  });

  it('reports a companion that exits after readiness as not alive', async () => {
    const connection = new IdbConnection('sim-a');
    expect(connection.alive).toBe(false);
    await connection.connect('idb');
    expect(connection.alive).toBe(true);
    const child = vi.mocked(spawn).mock.results[0].value;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    expect(connection.alive).toBe(false);
    // The socket stays known until disposal so commands fail fast and get classified.
    expect(connection.env.IDB_COMPANION).toBe(
      '/tmp/device-mcp-idb-1/companion.sock',
    );
    await connection.dispose();
    expect(rm).toHaveBeenCalledWith('/tmp/device-mcp-idb-1', {
      recursive: true,
      force: true,
    });
  });

  it('ignores a late exit from a replaced companion', async () => {
    const connection = new IdbConnection('sim-a');
    await connection.connect('idb');
    const first = vi.mocked(spawn).mock.results[0].value;
    await connection.dispose();
    await connection.connect('idb');
    expect(connection.alive).toBe(true);
    first.emit('exit', 0, null);
    expect(connection.alive).toBe(true);
    await connection.dispose();
    expect(connection.alive).toBe(false);
  });

  it('does not start resources when disposing an unused connection', async () => {
    await new IdbConnection('sim-a').dispose();
    expect(spawn).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('cleans up a child that reports an unexpected socket', async () => {
    const child = childProcess();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() =>
        child.stdout.write('{"grpc_path":"/tmp/not-ours"}\n'),
      );
      return child as unknown as ReturnType<typeof spawn>;
    });
    const connection = new IdbConnection('sim-a');
    await expect(connection.connect('idb')).rejects.toThrow(
      'unexpected socket',
    );
    await connection.dispose();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('escalates only its own child when TERM does not stop it', async () => {
    vi.useFakeTimers();
    const connection = new IdbConnection('sim-a');
    const connecting = connection.connect('idb');
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    const child = vi.mocked(spawn).mock.results[0].value;
    vi.mocked(child.kill).mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        child.emit('exit', null, signal);
      }
      return true;
    });
    const disposing = connection.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    await disposing;
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('fails without creating resources when no companion executable is available', async () => {
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
    await expect(new IdbConnection('sim-a').connect('idb')).rejects.toThrow(
      'idb_companion not found',
    );
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['spawn error', 'early exit', 'invalid JSON', 'oversized report'])(
    'releases partial startup resources after %s',
    async (failure) => {
      const child = childProcess();
      vi.mocked(spawn).mockImplementation(() => {
        queueMicrotask(() => {
          switch (failure) {
            case 'spawn error':
              child.exitCode = -1;
              child.emit('error', new Error('spawn failed'));
              break;
            case 'early exit':
              child.stderr.write('companion failed');
              child.exitCode = 1;
              child.emit('exit', 1);
              break;
            case 'invalid JSON':
              child.stdout.write('invalid\n');
              break;
            default:
              child.stdout.write('x'.repeat(65_537));
          }
        });
        return child as unknown as ReturnType<typeof spawn>;
      });
      const connection = new IdbConnection('sim-a');
      await expect(connection.connect('idb')).rejects.toThrow(/.+/u);
      await connection.dispose();
      expect(rm).toHaveBeenCalledWith('/tmp/device-mcp-idb-1', {
        recursive: true,
        force: true,
      });
    },
  );

  it('times out startup and permits cleanup of the unready child', async () => {
    vi.useFakeTimers();
    const child = childProcess();
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    const connection = new IdbConnection('sim-a');
    const failed = connection.connect('idb').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failed).toMatchObject({
      message: 'Timed out starting private IDB companion',
    });
    await connection.dispose();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('retains ownership for a retry when stopping the child times out', async () => {
    vi.useFakeTimers();
    const connection = new IdbConnection('sim-a');
    const connecting = connection.connect('idb');
    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    const child = vi.mocked(spawn).mock.results[0].value;
    vi.mocked(child.kill).mockReturnValue(true);
    const failed = connection.dispose().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await failed).toMatchObject({
      message: 'Timed out stopping owned child process',
    });
    expect(rm).not.toHaveBeenCalled();
    const retry = connection.dispose();
    child.emit('exit', 0);
    await retry;
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
