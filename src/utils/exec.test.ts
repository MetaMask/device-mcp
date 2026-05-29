import * as childProcess from 'node:child_process';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { exec, execStrict, isCommandAvailable } from './exec.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCallback = (
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

function simulateExecFile(
  error: (Error & { code?: string }) | null,
  stdout: string,
  stderr: string,
  exitCode: number,
) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const child = { exitCode } as ReturnType<typeof childProcess.execFile>;
    process.nextTick(() => {
      (callback as ExecFileCallback)(error, stdout, stderr);
    });
    return child;
  });
}

describe('exec', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('resolves with stdout and exit code 0 on success', async () => {
    simulateExecFile(null, 'output', '', 0);

    const result = await exec('echo', ['hello']);

    expect(result).toStrictEqual({
      exitCode: 0,
      stdout: 'output',
      stderr: '',
    });
  });

  it('resolves with non-zero exit code for normal failures', async () => {
    const error = Object.assign(new Error('exit 1'), { code: 'ERR' });
    simulateExecFile(error, '', 'fail', 1);

    const result = await exec('false', []);

    expect(result.exitCode).toBe(1);
  });

  it('rejects on ENOENT (command not found)', async () => {
    const error = Object.assign(new Error('spawn bad ENOENT'), {
      code: 'ENOENT',
    });
    simulateExecFile(error, '', '', 1);

    await expect(exec('nonexistent', [])).rejects.toThrow('spawn bad ENOENT');
  });

  it('rejects on EACCES (permission denied)', async () => {
    const error = Object.assign(new Error('spawn EACCES'), {
      code: 'EACCES',
    });
    simulateExecFile(error, '', '', 1);

    await expect(exec('restricted', [])).rejects.toThrow('spawn EACCES');
  });

  it('rejects on EPERM', async () => {
    const error = Object.assign(new Error('spawn EPERM'), {
      code: 'EPERM',
    });
    simulateExecFile(error, '', '', 1);

    await expect(exec('noperm', [])).rejects.toThrow('spawn EPERM');
  });

  it('uses exitCode 1 when child.exitCode is null and error has non-spawn code', async () => {
    const error = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const child = {
        exitCode: null,
      } as unknown as ReturnType<typeof childProcess.execFile>;
      process.nextTick(() => {
        (callback as ExecFileCallback)(error, '', '');
      });
      return child;
    });

    const result = await exec('slow', []);

    expect(result.exitCode).toBe(1);
  });

  it('uses exitCode 0 when child.exitCode is null and no error', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
      const child = {
        exitCode: null,
      } as unknown as ReturnType<typeof childProcess.execFile>;
      process.nextTick(() => {
        (callback as ExecFileCallback)(null, 'ok', '');
      });
      return child;
    });

    const result = await exec('cmd', []);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });
});

describe('execStrict', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns stdout on exit code 0', async () => {
    simulateExecFile(null, 'result\n', '', 0);

    const stdout = await execStrict('echo', ['test']);

    expect(stdout).toBe('result\n');
  });

  it('throws on non-zero exit code', async () => {
    const error = Object.assign(new Error('exit 1'), { code: 'ERR' });
    simulateExecFile(error, '', 'bad input', 1);

    await expect(execStrict('cmd', ['arg'])).rejects.toThrow(
      'Command failed: cmd arg',
    );
  });
});

describe('isCommandAvailable', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns true when which exits 0', async () => {
    simulateExecFile(null, '/usr/bin/git\n', '', 0);

    const available = await isCommandAvailable('git');

    expect(available).toBe(true);
  });

  it('returns false when which exits non-zero', async () => {
    const error = Object.assign(new Error('exit 1'), { code: 'ERR' });
    simulateExecFile(error, '', '', 1);

    const available = await isCommandAvailable('nonexistent');

    expect(available).toBe(false);
  });

  it('returns false when which itself cannot be spawned', async () => {
    const error = Object.assign(new Error('spawn ENOENT'), {
      code: 'ENOENT',
    });
    simulateExecFile(error, '', '', 1);

    const available = await isCommandAvailable('anything');

    expect(available).toBe(false);
  });
});
