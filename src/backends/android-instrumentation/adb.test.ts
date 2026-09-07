import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createAndroidAdbExecutor } from './adb.js';
import * as execModule from '../../utils/exec.js';

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
}));

const mockExec = vi.mocked(execModule.exec);

describe('createAndroidAdbExecutor', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
  });

  it('prefixes every call with -s <serial>', async () => {
    const run = createAndroidAdbExecutor('emulator-5554');
    await run(['shell', 'pm', 'path', 'com.example']);

    expect(mockExec).toHaveBeenCalledWith(
      'adb',
      ['-s', 'emulator-5554', 'shell', 'pm', 'path', 'com.example'],
      expect.objectContaining({ maxBuffer: 16 * 1024 * 1024 }),
    );
  });

  it('forwards the caller timeout', async () => {
    const run = createAndroidAdbExecutor('serial123');
    await run(['pull', '/data/app/base.apk', '/tmp/base.apk'], {
      timeoutMs: 60_000,
    });

    expect(mockExec).toHaveBeenCalledWith(
      'adb',
      ['-s', 'serial123', 'pull', '/data/app/base.apk', '/tmp/base.apk'],
      expect.objectContaining({ timeoutMs: 60_000 }),
    );
  });

  it('lets the caller override maxBuffer', async () => {
    const run = createAndroidAdbExecutor('serial123');
    await run(['shell', 'echo', 'hi'], { maxBuffer: 1024 });

    expect(mockExec).toHaveBeenCalledWith(
      'adb',
      ['-s', 'serial123', 'shell', 'echo', 'hi'],
      expect.objectContaining({ maxBuffer: 1024 }),
    );
  });

  it('returns the exec result unchanged', async () => {
    mockExec.mockResolvedValue({
      stdout: 'package:/data/app/base.apk',
      stderr: '',
      exitCode: 0,
    });
    const run = createAndroidAdbExecutor('serial123');
    const result = await run(['shell', 'pm', 'path', 'com.example']);

    expect(result).toStrictEqual({
      stdout: 'package:/data/app/base.apk',
      stderr: '',
      exitCode: 0,
    });
  });
});
