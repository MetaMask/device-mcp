// Derived from agent-device (MIT, Copyright (c) 2026 Callstack)
// https://github.com/callstackincubator/agent-device/blob/336bf17af44e9be1810592d5dc42163771c3e8de/src/platforms/android/snapshot-helper-install.ts
// See ./vendor/NOTICE.md and ./vendor/LICENSE.MIT for attribution.

import { verifyAndroidSnapshotHelperArtifact } from './artifact.js';
import { SnapshotHelperError } from './errors.js';
import { verifyInstalledAndroidSnapshotHelperSigner } from './signer.js';
import type {
  AndroidAdbExecutor,
  AndroidSnapshotHelperArtifact,
  AndroidSnapshotHelperInstallPolicy,
  AndroidSnapshotHelperInstallReason,
  AndroidSnapshotHelperInstallResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const VERSION_CODE = /(?:^|\s)versionCode:(\d+)(?:\s|$)/u;

export type EnsureAndroidSnapshotHelperOptions = {
  adb: AndroidAdbExecutor;
  artifact: AndroidSnapshotHelperArtifact;
  installPolicy?: AndroidSnapshotHelperInstallPolicy;
  timeoutMs?: number;
};

export async function ensureAndroidSnapshotHelper(
  options: EnsureAndroidSnapshotHelperOptions,
): Promise<AndroidSnapshotHelperInstallResult> {
  const { adb, artifact } = options;
  const installPolicy = options.installPolicy ?? 'missing-or-outdated';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { packageName, versionCode, expectedSignerSha256 } = artifact.manifest;

  if (installPolicy === 'never') {
    return {
      packageName,
      versionCode,
      installedVersionCode: undefined,
      installed: false,
      reason: 'skipped',
    };
  }

  const installedVersionCode =
    installPolicy === 'always'
      ? undefined
      : await readInstalledVersionCode(adb, packageName, timeoutMs);

  const reason = getInstallReason(
    installPolicy,
    installedVersionCode,
    versionCode,
  );

  if (reason === 'current') {
    await verifyInstalledAndroidSnapshotHelperSigner(
      adb,
      packageName,
      expectedSignerSha256,
      timeoutMs,
    );
    return {
      packageName,
      versionCode,
      installedVersionCode,
      installed: false,
      reason,
    };
  }

  await verifyAndroidSnapshotHelperArtifact(artifact);
  await installApk(adb, artifact, timeoutMs);
  await verifyInstalledAndroidSnapshotHelperSigner(
    adb,
    packageName,
    expectedSignerSha256,
    timeoutMs,
  );

  return {
    packageName,
    versionCode,
    installedVersionCode,
    installed: true,
    reason,
  };
}

function getInstallReason(
  installPolicy: AndroidSnapshotHelperInstallPolicy,
  installedVersionCode: number | undefined,
  requiredVersionCode: number,
): AndroidSnapshotHelperInstallReason {
  if (installPolicy === 'never') {
    return 'skipped';
  }
  if (installPolicy === 'always') {
    return 'forced';
  }
  if (installedVersionCode === undefined) {
    return 'missing';
  }
  return installedVersionCode < requiredVersionCode ? 'outdated' : 'current';
}

async function readInstalledVersionCode(
  adb: AndroidAdbExecutor,
  packageName: string,
  timeoutMs: number,
): Promise<number | undefined> {
  const result = await adb(
    [
      'shell',
      'cmd',
      'package',
      'list',
      'packages',
      '--show-versioncode',
      packageName,
    ],
    { allowFailure: true, timeoutMs },
  );
  if (result.exitCode !== 0) {
    return undefined;
  }
  const prefix = `package:${packageName}`;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!hasExactPackagePrefix(line, prefix)) {
      continue;
    }
    const match = VERSION_CODE.exec(line);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function hasExactPackagePrefix(line: string, prefix: string): boolean {
  if (!line.startsWith(prefix)) {
    return false;
  }
  const boundary = line[prefix.length];
  return boundary === undefined || /\s/u.test(boundary);
}

async function installApk(
  adb: AndroidAdbExecutor,
  artifact: AndroidSnapshotHelperArtifact,
  timeoutMs: number,
): Promise<void> {
  const { installArgs } = artifact.manifest;
  const first = await adb([...installArgs, artifact.apkPath], {
    allowFailure: true,
    timeoutMs,
  });
  if (first.exitCode === 0) {
    return;
  }

  const combined = `${first.stdout}\n${first.stderr}`;
  if (!combined.includes('INSTALL_FAILED_UPDATE_INCOMPATIBLE')) {
    throw installFailed(artifact.manifest.packageName, first);
  }
  const { packageName } = artifact.manifest;
  throw new SnapshotHelperError(
    'COMMAND_FAILED',
    `Failed to install Android snapshot helper: a conflicting package with a different signature is already installed under ${packageName}. To proceed, manually run "adb uninstall ${packageName}" and retry.`,
    { stdout: first.stdout, stderr: first.stderr, exitCode: first.exitCode },
  );
}

function installFailed(
  packageName: string,
  result: { stdout: string; stderr: string; exitCode: number },
): SnapshotHelperError {
  return new SnapshotHelperError(
    'COMMAND_FAILED',
    `Failed to install Android snapshot helper (${packageName})`,
    { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
  );
}
