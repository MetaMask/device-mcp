import { copyFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

import {
  computeApkV1SignerSha256,
  resolveBundledAndroidSnapshotHelper,
} from './index.js';
import { ensureAndroidSnapshotHelper } from './install.js';
import type {
  AndroidAdbExecutor,
  AndroidSnapshotHelperArtifact,
} from './types.js';

const BUNDLED_ARTIFACT = resolveBundledAndroidSnapshotHelper();
const REMOTE_APK_PATH = '/data/app/example/base.apk';

function ok(stdout = ''): { stdout: string; stderr: string; exitCode: number } {
  return { stdout, stderr: '', exitCode: 0 };
}

function copyBundledApk(args: string[]): void {
  if (args[0] === 'pull') {
    copyFileSync(BUNDLED_ARTIFACT.apkPath, args[2]);
  }
}

describe('ensureAndroidSnapshotHelper', () => {
  it('installs a missing helper and verifies its matching signer', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args[0] === 'shell') {
        if (args.includes('path')) {
          return ok(`package:${REMOTE_APK_PATH}`);
        }
        return ok('');
      }
      copyBundledApk(args);
      return ok();
    });

    const result = await ensureAndroidSnapshotHelper({
      adb,
      artifact: BUNDLED_ARTIFACT,
    });

    expect(result.reason).toBe('missing');
    expect(result.installed).toBe(true);
    expect(adb).toHaveBeenCalledWith(
      [...BUNDLED_ARTIFACT.manifest.installArgs, BUNDLED_ARTIFACT.apkPath],
      expect.objectContaining({ allowFailure: true }),
    );
  });

  it('rejects a checksum mismatch before invoking adb install', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args[0] === 'shell') {
        return ok('');
      }
      return ok();
    });
    const artifact: AndroidSnapshotHelperArtifact = {
      ...BUNDLED_ARTIFACT,
      manifest: { ...BUNDLED_ARTIFACT.manifest, sha256: '0'.repeat(64) },
    };

    await expect(
      ensureAndroidSnapshotHelper({ adb, artifact }),
    ).rejects.toThrow('Android snapshot helper APK checksum mismatch');

    expect(adb).not.toHaveBeenCalledWith(
      expect.arrayContaining(['install']),
      expect.anything(),
    );
  });

  it('accepts an installed-current helper with a matching signer', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args.includes('list')) {
        return ok(
          `package:${BUNDLED_ARTIFACT.manifest.packageName} versionCode:${BUNDLED_ARTIFACT.manifest.versionCode}`,
        );
      }
      if (args.includes('path')) {
        return ok(`package:${REMOTE_APK_PATH}`);
      }
      copyBundledApk(args);
      return ok();
    });

    const result = await ensureAndroidSnapshotHelper({
      adb,
      artifact: BUNDLED_ARTIFACT,
    });

    expect(result.reason).toBe('current');
    expect(result.installed).toBe(false);
    expect(adb.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  });

  it('rejects an installed-current helper with a mismatched signer', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args.includes('list')) {
        return ok(
          `package:${BUNDLED_ARTIFACT.manifest.packageName} versionCode:${BUNDLED_ARTIFACT.manifest.versionCode}`,
        );
      }
      if (args.includes('path')) {
        return ok(`package:${REMOTE_APK_PATH}`);
      }
      copyBundledApk(args);
      return ok();
    });
    const artifact = {
      ...BUNDLED_ARTIFACT,
      manifest: {
        ...BUNDLED_ARTIFACT.manifest,
        expectedSignerSha256: '0'.repeat(64),
      },
    };

    await expect(
      ensureAndroidSnapshotHelper({ adb, artifact }),
    ).rejects.toThrow('does not match pinned signer');
    expect(adb.mock.calls.some(([args]) => args[0] === 'install')).toBe(false);
  });

  it('rejects an installed-current helper when its signer is unparseable', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args.includes('list')) {
        return ok(
          `package:${BUNDLED_ARTIFACT.manifest.packageName} versionCode:${BUNDLED_ARTIFACT.manifest.versionCode}`,
        );
      }
      return ok('');
    });

    await expect(
      ensureAndroidSnapshotHelper({ adb, artifact: BUNDLED_ARTIFACT }),
    ).rejects.toThrow('could not resolve installed APK path');
  });

  it('installs when the installed version is outdated', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args[0] === 'shell') {
        if (args.includes('path')) {
          return ok(`package:${REMOTE_APK_PATH}`);
        }
        return ok(
          `package:${BUNDLED_ARTIFACT.manifest.packageName} versionCode:${BUNDLED_ARTIFACT.manifest.versionCode - 1}`,
        );
      }
      copyBundledApk(args);
      return ok();
    });

    const result = await ensureAndroidSnapshotHelper({
      adb,
      artifact: BUNDLED_ARTIFACT,
    });

    expect(result.reason).toBe('outdated');
    expect(result.installed).toBe(true);
  });

  it('never queries or installs under the never policy', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args.includes('path')) {
        return ok(`package:${REMOTE_APK_PATH}`);
      }
      copyBundledApk(args);
      return ok();
    });

    const result = await ensureAndroidSnapshotHelper({
      adb,
      artifact: BUNDLED_ARTIFACT,
      installPolicy: 'never',
    });

    expect(result.reason).toBe('skipped');
    expect(result.installed).toBe(false);
    expect(adb).not.toHaveBeenCalled();
  });

  it('force-installs under the always policy without querying the version', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args.includes('path')) {
        return ok(`package:${REMOTE_APK_PATH}`);
      }
      copyBundledApk(args);
      return ok();
    });

    const result = await ensureAndroidSnapshotHelper({
      adb,
      artifact: BUNDLED_ARTIFACT,
      installPolicy: 'always',
    });

    expect(result.reason).toBe('forced');
    expect(adb).toHaveBeenCalledWith(
      [...BUNDLED_ARTIFACT.manifest.installArgs, BUNDLED_ARTIFACT.apkPath],
      expect.anything(),
    );
  });

  it('fails actionably without uninstalling on INSTALL_FAILED_UPDATE_INCOMPATIBLE', async () => {
    const calls: string[][] = [];
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      calls.push(args);
      if (args[0] === 'shell') {
        return ok('');
      }
      if (
        args[0] === 'install' &&
        calls.filter((c) => c[0] === 'install').length === 1
      ) {
        return {
          stdout: '',
          stderr: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
          exitCode: 1,
        };
      }
      return ok();
    });

    await expect(
      ensureAndroidSnapshotHelper({ adb, artifact: BUNDLED_ARTIFACT }),
    ).rejects.toThrow(
      `manually run "adb uninstall ${BUNDLED_ARTIFACT.manifest.packageName}"`,
    );
    expect(calls.some((c) => c[0] === 'uninstall')).toBe(false);
    expect(calls.filter((c) => c[0] === 'install')).toHaveLength(1);
  });

  it('throws when install fails for an unrelated reason', async () => {
    const adb = vi.fn<AndroidAdbExecutor>(async (args) => {
      if (args[0] === 'shell') {
        return ok('');
      }
      return {
        stdout: '',
        stderr: 'INSTALL_FAILED_INSUFFICIENT_STORAGE',
        exitCode: 1,
      };
    });

    await expect(
      ensureAndroidSnapshotHelper({ adb, artifact: BUNDLED_ARTIFACT }),
    ).rejects.toThrow('Failed to install Android snapshot helper');
  });

  it('computes the pinned signer from the real bundled APK', async () => {
    expect(await computeApkV1SignerSha256(BUNDLED_ARTIFACT.apkPath)).toBe(
      'f5dc3a7bf83a1b17312c222cd89a2f781230f34a7a407e6033fa28adf0b3cf48',
    );
  });
});
