import { rmSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as adbModule from './adb.js';
import * as artifactModule from './artifact.js';
import { UntrustedHelperError } from './errors.js';
import {
  INSTRUMENTATION_NOT_FOUND_SIGNATURE,
  ensureHelperTrusted,
  installHelper,
  isHelperInstalled,
  resolveHelperApkPath,
} from './installer.js';
import * as signerModule from './signer.js';
import * as execModule from '../../utils/exec.js';
import * as outputPathModule from '../../utils/output-path.js';

vi.mock('./artifact.js', () => ({
  loadHelperArtifact: vi.fn(),
}));

vi.mock('./signer.js', () => ({
  assertApkSignerSha256: vi.fn(),
}));

vi.mock('./adb.js', () => ({
  createAndroidAdbExecutor: vi.fn(),
}));

vi.mock('../../utils/output-path.js', () => ({
  createPrivateTempDir: vi.fn(),
}));

vi.mock('../../utils/exec.js', () => ({
  exec: vi.fn(),
}));

vi.mock('node:fs', () => ({
  rmSync: vi.fn(),
}));

const mockLoadArtifact = vi.mocked(artifactModule.loadHelperArtifact);
const mockAssertSigner = vi.mocked(signerModule.assertApkSignerSha256);
const mockCreateExecutor = vi.mocked(adbModule.createAndroidAdbExecutor);
const mockCreateTempDir = vi.mocked(outputPathModule.createPrivateTempDir);
const mockExec = vi.mocked(execModule.exec);
const mockRmSync = vi.mocked(rmSync);

const ARTIFACT = {
  version: '0.3.3',
  versionCode: 3003,
  packageName: 'io.metamask.devicemcp.snapshothelper',
  instrumentationRunner:
    'io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation',
  apkPath: '/pkg/dist/android/device-mcp-android-snapshot-helper-0.3.3.apk',
  sha256: 'a'.repeat(64),
  signerSha256:
    '0554218930d76c296dc6099049cb1659180acdd64ad59ee6e4b0548bcdd7641f',
  minSdk: 23,
};

describe('android-instrumentation/installer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadArtifact.mockResolvedValue(ARTIFACT);
    mockCreateTempDir.mockReturnValue('/tmp/helper-verify-xxx');
    mockAssertSigner.mockResolvedValue(undefined);
  });

  describe('constants', () => {
    it('exposes the am instrument not-found signature', () => {
      expect(INSTRUMENTATION_NOT_FOUND_SIGNATURE).toBe(
        'INSTRUMENTATION_FAILED',
      );
    });
  });

  describe('resolveHelperApkPath', () => {
    it('returns the APK path from the validated artifact', async () => {
      expect(await resolveHelperApkPath()).toBe(ARTIFACT.apkPath);
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
      mockExec.mockResolvedValue({
        stdout: 'Success\n',
        stderr: '',
        exitCode: 0,
      });

      await installHelper('emulator-5554');

      const [, args] = mockExec.mock.calls[0];
      expect(args).toStrictEqual(
        expect.arrayContaining(['install', '-r', '-t', ARTIFACT.apkPath]),
      );
    });

    it('throws when the install does not report Success', async () => {
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

  describe('ensureHelperTrusted', () => {
    const wireExecutor = (pmPathStdout: string, pullExit = 0): void => {
      const run = vi.fn(async (args: string[]) => {
        if (args.includes('path')) {
          return { stdout: pmPathStdout, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: pullExit };
      });
      mockCreateExecutor.mockReturnValue(run);
    };

    it('installs when the helper is absent, then verifies the signer', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Success\n',
        stderr: '',
        exitCode: 0,
      });
      wireExecutor(
        'package:/data/app/io.metamask.devicemcp.snapshothelper/base.apk',
      );

      await ensureHelperTrusted('emulator-5554');

      const installCall = mockExec.mock.calls.find((call) =>
        call[1]?.includes('install'),
      );
      expect(installCall).toBeDefined();
      expect(mockAssertSigner).toHaveBeenCalledWith(
        expect.stringContaining('apk-0.apk'),
        ARTIFACT.signerSha256,
      );
    });

    it('skips install when a same/newer version is present, but still verifies', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionName=0.3.3\n  versionCode=3003 minSdk=23\n',
        stderr: '',
        exitCode: 0,
      });
      wireExecutor(
        'package:/data/app/io.metamask.devicemcp.snapshothelper/base.apk',
      );

      await ensureHelperTrusted('emulator-5554');

      const installCall = mockExec.mock.calls.find((call) =>
        call[1]?.includes('install'),
      );
      expect(installCall).toBeUndefined();
      expect(mockAssertSigner).toHaveBeenCalledTimes(1);
    });

    it('verifies every split APK', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });
      wireExecutor(
        'package:/data/app/pkg/base.apk\npackage:/data/app/pkg/split_config.apk\n',
      );

      await ensureHelperTrusted('emulator-5554');

      expect(mockAssertSigner).toHaveBeenCalledTimes(2);
    });

    it('propagates UntrustedHelperError from the signer check', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });
      wireExecutor('package:/data/app/pkg/base.apk');
      mockAssertSigner.mockRejectedValue(
        new UntrustedHelperError('mismatch', {
          expectedSignerSha256: ARTIFACT.signerSha256,
          actualSignerSha256: 'bbbb',
        }),
      );

      await expect(ensureHelperTrusted('emulator-5554')).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('fails closed when the installed APK path cannot be resolved', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });
      wireExecutor('');

      await expect(ensureHelperTrusted('emulator-5554')).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
    });
  });
});
