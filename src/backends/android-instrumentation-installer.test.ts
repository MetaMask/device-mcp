import { readdir } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  INSTRUMENTATION_NOT_FOUND_SIGNATURE,
  installHelper,
  isHelperInstalled,
  resolveHelperApkPath,
} from './android-instrumentation-installer.js';
import * as execModule from '../utils/exec.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
}));

const mockReaddir = vi.mocked(readdir);
const mockExec = vi.mocked(execModule.exec);

/**
 * Cast a string array to the `readdir` return type without pulling in Dirent.
 *
 * @param names - The filenames the mocked `readdir` should yield.
 * @returns The names typed as `readdir`'s resolved value.
 */
function asDirEntries(names: string[]): Awaited<ReturnType<typeof readdir>> {
  return names as unknown as Awaited<ReturnType<typeof readdir>>;
}

describe('android-instrumentation-installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constants', () => {
    it('exposes the am instrument not-found signature', () => {
      expect(INSTRUMENTATION_NOT_FOUND_SIGNATURE).toBe(
        'INSTRUMENTATION_FAILED',
      );
    });
  });

  describe('resolveHelperApkPath', () => {
    it('returns the newest matching APK by name', async () => {
      mockReaddir.mockResolvedValue(
        asDirEntries([
          'device-mcp-android-snapshot-helper-0.3.2.apk',
          'device-mcp-android-snapshot-helper-0.3.3.apk',
          'unrelated.txt',
        ]),
      );

      const path = await resolveHelperApkPath();

      expect(path).toMatch(
        /android[/\\]device-mcp-android-snapshot-helper-0\.3\.3\.apk$/u,
      );
    });

    it('throws when no APK is present', async () => {
      mockReaddir.mockResolvedValue(asDirEntries(['readme.md']));

      await expect(resolveHelperApkPath()).rejects.toThrow(
        /No snapshot helper APK found/u,
      );
    });

    it('throws a clear error when the directory is missing', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      await expect(resolveHelperApkPath()).rejects.toThrow(
        /directory is missing/u,
      );
    });
  });

  describe('isHelperInstalled', () => {
    it('confirms the exact package, not a substring match', async () => {
      mockExec.mockResolvedValue({
        stdout: 'package:io.metamask.devicemcp.snapshothelper\n',
        stderr: '',
        exitCode: 0,
      });

      expect(await isHelperInstalled('emulator-5554')).toBe(true);
    });

    it('returns false when the package is absent', async () => {
      mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      expect(await isHelperInstalled('emulator-5554')).toBe(false);
    });
  });

  describe('installHelper', () => {
    it('installs with -r -t and succeeds on a Success banner', async () => {
      mockReaddir.mockResolvedValue(
        asDirEntries(['device-mcp-android-snapshot-helper-0.3.3.apk']),
      );
      mockExec.mockResolvedValue({
        stdout: 'Success\n',
        stderr: '',
        exitCode: 0,
      });

      await installHelper('emulator-5554');

      const [, args] = mockExec.mock.calls[0];
      expect(args).toStrictEqual(
        expect.arrayContaining(['install', '-r', '-t']),
      );
    });

    it('throws when the install does not report Success', async () => {
      mockReaddir.mockResolvedValue(
        asDirEntries(['device-mcp-android-snapshot-helper-0.3.3.apk']),
      );
      mockExec.mockResolvedValue({
        stdout: '',
        stderr: 'INSTALL_FAILED_TEST_ONLY',
        exitCode: 1,
      });

      await expect(installHelper('emulator-5554')).rejects.toThrow(
        /Failed to install snapshot helper APK[\s\S]*INSTALL_FAILED_TEST_ONLY/u,
      );
    });
  });
});
