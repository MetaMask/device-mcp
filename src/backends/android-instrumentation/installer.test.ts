import { rmSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AdbBackend } from '../adb-backend.js';
import * as adbModule from './adb.js';
import * as artifactModule from './artifact.js';
import {
  HelperNotInstalledError,
  SnapshotHelperError,
  UNTRUSTED_HELPER_REMEDY,
  UntrustedHelperError,
} from './errors.js';
import {
  HelperTrustCache,
  INSTRUMENTATION_NOT_FOUND_SIGNATURE,
  assertInstalledHelperTrusted,
  ensureHelperInstalled,
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
  execStrict: vi.fn(),
}));

vi.mock('node:fs', () => ({
  rmSync: vi.fn(),
}));

const mockLoadArtifact = vi.mocked(artifactModule.loadHelperArtifact);
const mockAssertSigner = vi.mocked(signerModule.assertApkSignerSha256);
const mockCreateExecutor = vi.mocked(adbModule.createAndroidAdbExecutor);
const mockCreateTempDir = vi.mocked(outputPathModule.createPrivateTempDir);
const mockExec = vi.mocked(execModule.exec);
const mockExecStrict = vi.mocked(execModule.execStrict);
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

  const wireDevice = (state: {
    pmPath: string;
    pathExitCode?: number;
    packageList?: string;
    packageListExitCode?: number;
    sdk?: string;
    sdkExitCode?: number;
    pullExitCode?: number;
  }) => {
    const run = vi.fn(async (args: string[]) => {
      if (args.includes('path')) {
        return {
          stdout: state.pmPath,
          stderr: '',
          exitCode: state.pathExitCode ?? 0,
        };
      }
      if (args.includes('getprop')) {
        return {
          stdout: state.sdk ?? '34',
          stderr: '',
          exitCode: state.sdkExitCode ?? 0,
        };
      }
      if (args.includes('list')) {
        return {
          stdout: state.packageList ?? '',
          stderr: '',
          exitCode: state.packageListExitCode ?? 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: state.pullExitCode ?? 0 };
    });
    mockCreateExecutor.mockReturnValue(run);
    return run;
  };

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

    it('keeps the install error when no helper remains installed', async () => {
      mockExec.mockResolvedValue({
        stdout: '',
        stderr: 'INSTALL_FAILED_TEST_ONLY',
        exitCode: 1,
      });
      wireDevice({ pmPath: '' });

      await expect(installHelper('emulator-5554')).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringMatching(
          /Failed to install snapshot helper APK[\s\S]*INSTALL_FAILED_TEST_ONLY/u,
        ),
      });
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });

    it.each([
      'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
      'INSTALL_FAILED_SHARED_USER_INCOMPATIBLE',
      'INSTALL_FAILED_VERIFICATION_FAILURE',
      'INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES',
      'OEM_INSTALL_REJECTED',
    ])('fails closed on a foreign signer after %s', async (token) => {
      mockExec.mockResolvedValue({
        stdout: `Failure [${token}]`,
        stderr: '',
        exitCode: 1,
      });
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
      const trustError = new UntrustedHelperError(UNTRUSTED_HELPER_REMEDY, {
        expectedSignerSha256: ARTIFACT.signerSha256,
        actualSignerSha256: 'b'.repeat(64),
      });
      mockAssertSigner.mockRejectedValue(trustError);

      await expect(installHelper('emulator-5554')).rejects.toBe(trustError);
      expect(mockAssertSigner).toHaveBeenCalledWith(
        expect.stringContaining('apk-0.apk'),
        ARTIFACT.signerSha256,
      );
    });

    it('keeps the install error when the installed signer matches, regardless of the token', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Failure [INSTALL_FAILED_SHARED_USER_INCOMPATIBLE]',
        stderr: '',
        exitCode: 1,
      });
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });

      await expect(installHelper('emulator-5554')).rejects.toMatchObject({
        name: 'Error',
        message: expect.stringContaining(
          'INSTALL_FAILED_SHARED_USER_INCOMPATIBLE',
        ),
      });
      expect(mockAssertSigner).toHaveBeenCalledTimes(1);
    });

    it.each([
      new SnapshotHelperError('ARTIFACT_INVALID', 'Unsupported APK signature'),
      new Error('Could not read pulled APK'),
    ])('fails closed when signer verification fails: %s', async (cause) => {
      mockExec.mockResolvedValue({
        stdout: 'Failure [OEM_INSTALL_REJECTED]',
        stderr: '',
        exitCode: 1,
      });
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
      mockAssertSigner.mockRejectedValue(cause);

      await expect(installHelper('emulator-5554')).rejects.toMatchObject({
        name: 'UntrustedHelperError',
        expectedSignerSha256: ARTIFACT.signerSha256,
        message: expect.stringContaining('could not be verified'),
        cause,
      });
    });

    it('checks trust even when the install command rejects', async () => {
      mockExec.mockRejectedValueOnce(new Error('Could not start adb'));
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
      const trustError = new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: ARTIFACT.signerSha256,
      });
      mockAssertSigner.mockRejectedValue(trustError);

      await expect(installHelper('emulator-5554')).rejects.toBe(trustError);
    });
  });

  describe('snapshot after an install failure', () => {
    const DUMP_XML =
      '<hierarchy><node text="dump" bounds="[0,0][1,1]" /></hierarchy>';

    beforeEach(() => {
      mockExecStrict.mockReset();
      mockExec.mockImplementation(async (_command, args) => ({
        stdout: args.includes('dumpsys')
          ? 'versionCode=1\n'
          : 'Failure [INSTALL_FAILED_VERIFICATION_FAILURE]',
        stderr: '',
        exitCode: args.includes('install') ? 1 : 0,
      }));
    });

    it.each(['helper-first', 'auto', 'instrument'] as const)(
      '%s: a foreign signer stops capture without a retry or dump fallback',
      async (snapshotMode) => {
        const backend = new AdbBackend('emulator-5554', { snapshotMode });
        wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
        const trustError = new UntrustedHelperError('signer mismatch', {
          expectedSignerSha256: ARTIFACT.signerSha256,
          actualSignerSha256: 'b'.repeat(64),
        });
        mockAssertSigner.mockRejectedValue(trustError);
        // Let auto's initial dump fail, but make any fallback succeed.
        mockExecStrict
          .mockResolvedValue(DUMP_XML)
          .mockResolvedValueOnce(snapshotMode === 'auto' ? '' : DUMP_XML);

        await expect(backend.snapshot()).rejects.toBe(trustError);

        const countCalls = (token: string): number =>
          mockExec.mock.calls.filter(([, args]) => args.includes(token)).length;
        expect(countCalls('install')).toBe(1);
        expect(countCalls('instrument')).toBe(0);
        expect(countCalls('uiautomator')).toBe(snapshotMode === 'auto' ? 1 : 0);
        expect(mockAssertSigner).toHaveBeenCalledTimes(1);
      },
    );

    it('helper-first: stops capture when the remaining package cannot be verified', async () => {
      const backend = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
      mockAssertSigner.mockRejectedValue(
        new SnapshotHelperError(
          'ARTIFACT_INVALID',
          'Unsupported APK signature',
        ),
      );
      mockExecStrict.mockResolvedValue(DUMP_XML);

      await expect(backend.snapshot()).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
      expect(
        mockExec.mock.calls.some(
          ([, args]) =>
            args.includes('uiautomator') || args.includes('instrument'),
        ),
      ).toBe(false);
    });

    it.each(['absent', 'trusted'] as const)(
      'helper-first: keeps dump fallback when the helper is %s',
      async (state) => {
        const backend = new AdbBackend('emulator-5554', {
          snapshotMode: 'helper-first',
        });
        wireDevice({
          pmPath: state === 'absent' ? '' : 'package:/data/app/pkg/base.apk',
          pathExitCode: state === 'absent' ? 1 : 0,
        });
        mockExecStrict.mockResolvedValue(DUMP_XML);

        const snapshot = await backend.snapshot();

        expect(snapshot.source).toBe('dump');
        expect(snapshot.hierarchy[0].value).toBe('dump');
        expect(
          mockExec.mock.calls.some(([, args]) => args.includes('instrument')),
        ).toBe(false);
      },
    );
  });

  describe('ensureHelperTrusted', () => {
    it('installs when the helper is absent, then verifies the signer', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Success\n',
        stderr: '',
        exitCode: 0,
      });
      wireDevice({
        pmPath:
          'package:/data/app/io.metamask.devicemcp.snapshothelper/base.apk',
      });

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
      wireDevice({
        pmPath:
          'package:/data/app/io.metamask.devicemcp.snapshothelper/base.apk',
      });

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
      wireDevice({
        pmPath:
          'package:/data/app/pkg/base.apk\npackage:/data/app/pkg/split_config.apk\n',
      });

      await ensureHelperTrusted('emulator-5554');

      expect(mockAssertSigner).toHaveBeenCalledTimes(2);
    });

    it('propagates UntrustedHelperError from the signer check', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
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

    it('reports a missing helper, not a trust failure, when pm path finds no APK', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });
      wireDevice({ pmPath: '' });

      await expect(ensureHelperTrusted('emulator-5554')).rejects.toBeInstanceOf(
        HelperNotInstalledError,
      );
    });
  });

  describe('ensureHelperInstalled', () => {
    it('leaves signer verification to the caller after a successful install', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Success\n',
        stderr: '',
        exitCode: 0,
      });

      await ensureHelperInstalled('emulator-5554');

      const installCall = mockExec.mock.calls.find((call) =>
        call[1]?.includes('install'),
      );
      expect(installCall).toBeDefined();
      // A successful install does not establish per-use trust.
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });

    it('skips install when a same/newer version is present', async () => {
      mockExec.mockResolvedValue({
        stdout: 'versionCode=3003\n',
        stderr: '',
        exitCode: 0,
      });

      await ensureHelperInstalled('emulator-5554');

      const installCall = mockExec.mock.calls.find((call) =>
        call[1]?.includes('install'),
      );
      expect(installCall).toBeUndefined();
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });
  });

  describe('assertInstalledHelperTrusted', () => {
    it('verifies the installed signer without installing', async () => {
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });

      await assertInstalledHelperTrusted('emulator-5554');

      // The per-use trust check must never install/upgrade — only verify.
      const installCall = mockExec.mock.calls.find((call) =>
        call[1]?.includes('install'),
      );
      expect(installCall).toBeUndefined();
      expect(mockAssertSigner).toHaveBeenCalledWith(
        expect.stringContaining('apk-0.apk'),
        ARTIFACT.signerSha256,
      );
    });

    it('propagates UntrustedHelperError from the signer check', async () => {
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk' });
      mockAssertSigner.mockRejectedValue(
        new UntrustedHelperError('mismatch', {
          expectedSignerSha256: ARTIFACT.signerSha256,
          actualSignerSha256: 'bbbb',
        }),
      );

      await expect(
        assertInstalledHelperTrusted('emulator-5554'),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockRmSync).toHaveBeenCalled();
    });

    it('throws HelperNotInstalledError (not a trust error) when pm path finds no APK', async () => {
      wireDevice({ pmPath: '', pathExitCode: 1 });

      await expect(
        assertInstalledHelperTrusted('emulator-5554'),
      ).rejects.toThrow(HelperNotInstalledError);
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });

    it('fails closed when pm path returns no APK for an installed package', async () => {
      wireDevice({
        pmPath: '',
        pathExitCode: 1,
        packageList: `package:${ARTIFACT.packageName}\n`,
      });

      await expect(
        assertInstalledHelperTrusted('emulator-5554'),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });

    it('fails closed when package absence cannot be confirmed', async () => {
      wireDevice({ pmPath: '', pathExitCode: 1, packageListExitCode: 1 });

      await expect(
        assertInstalledHelperTrusted('emulator-5554'),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });

    it('fails closed when pm path reports an error despite returning a path', async () => {
      wireDevice({ pmPath: 'package:/data/app/pkg/base.apk', pathExitCode: 1 });

      await expect(
        assertInstalledHelperTrusted('emulator-5554'),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockAssertSigner).not.toHaveBeenCalled();
    });
  });

  describe('assertInstalledHelperTrusted with a trust cache', () => {
    const PATH_A =
      'package:/data/app/~~abc==/io.metamask.devicemcp.snapshothelper-x1==/base.apk';
    const PATH_B =
      'package:/data/app/~~def==/io.metamask.devicemcp.snapshothelper-y2==/base.apk';

    const countCalls = (
      run: ReturnType<typeof wireDevice>,
      token: string,
    ): number => run.mock.calls.filter(([args]) => args.includes(token)).length;

    it('runs pm path every time but skips the pull when the path is unchanged', async () => {
      const run = wireDevice({ pmPath: PATH_A });
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      await assertInstalledHelperTrusted('emulator-5554', cache);
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'path')).toBe(3);
      expect(countCalls(run, 'pull')).toBe(1);
      expect(mockAssertSigner).toHaveBeenCalledTimes(1);
      expect(countCalls(run, 'getprop')).toBe(1);
    });

    it('pulls and verifies again when the installed path changes', async () => {
      const state = { pmPath: PATH_A };
      const run = wireDevice(state);
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      state.pmPath = PATH_B;
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(2);
      expect(run).toHaveBeenCalledWith(
        ['pull', PATH_B.slice('package:'.length), expect.any(String)],
        expect.anything(),
      );
      expect(mockAssertSigner).toHaveBeenCalledTimes(2);
    });

    it('pulls again when a split APK is added at the same base path', async () => {
      const state = { pmPath: PATH_A };
      const run = wireDevice(state);
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      state.pmPath = `${PATH_A}\npackage:/data/app/~~abc==/split_config.apk`;
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(3);
    });

    it('fails closed when the changed install has a foreign signer, and keeps failing', async () => {
      const state = { pmPath: PATH_A };
      wireDevice(state);
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);

      state.pmPath = PATH_B;
      mockAssertSigner.mockRejectedValue(
        new UntrustedHelperError('mismatch', {
          expectedSignerSha256: ARTIFACT.signerSha256,
          actualSignerSha256: 'bbbb',
        }),
      );

      await expect(
        assertInstalledHelperTrusted('emulator-5554', cache),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      await expect(
        assertInstalledHelperTrusted('emulator-5554', cache),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockAssertSigner).toHaveBeenCalledTimes(3);
    });

    it('clears the cache when the helper is not installed', async () => {
      const state = { pmPath: PATH_A };
      const run = wireDevice(state);
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      state.pmPath = '';
      await expect(
        assertInstalledHelperTrusted('emulator-5554', cache),
      ).rejects.toBeInstanceOf(HelperNotInstalledError);
      state.pmPath = PATH_A;
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(2);
    });

    it('does not remember a path after a failed pull', async () => {
      const run = wireDevice({ pmPath: PATH_A, pullExitCode: 1 });
      const cache = new HelperTrustCache();

      await expect(
        assertInstalledHelperTrusted('emulator-5554', cache),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      await expect(
        assertInstalledHelperTrusted('emulator-5554', cache),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(countCalls(run, 'pull')).toBe(2);
    });

    it('never skips the pull before Android 8.0 (API 26), where paths repeat', async () => {
      const run = wireDevice({ pmPath: PATH_A, sdk: '25' });
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(2);
    });

    it('never skips the pull when the API level cannot be read', async () => {
      const run = wireDevice({ pmPath: PATH_A, sdk: '', sdkExitCode: 1 });
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(2);
      // A failed read is retried rather than remembered.
      expect(countCalls(run, 'getprop')).toBe(2);
    });

    it('pulls again when the pinned signer changes', async () => {
      const run = wireDevice({ pmPath: PATH_A });
      const cache = new HelperTrustCache();

      await assertInstalledHelperTrusted('emulator-5554', cache);
      mockLoadArtifact.mockResolvedValue({
        ...ARTIFACT,
        signerSha256: 'c'.repeat(64),
      });
      await assertInstalledHelperTrusted('emulator-5554', cache);

      expect(countCalls(run, 'pull')).toBe(2);
    });

    it('always pulls without a cache', async () => {
      const run = wireDevice({ pmPath: PATH_A });

      await assertInstalledHelperTrusted('emulator-5554');
      await assertInstalledHelperTrusted('emulator-5554');

      expect(countCalls(run, 'pull')).toBe(2);
      expect(countCalls(run, 'getprop')).toBe(0);
    });
  });
});
