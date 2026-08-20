/**
 * Installs and TRUSTS the bundled Android snapshot-helper instrumentation APK.
 *
 * The APK is built during `prepack` into `dist/android/` and shipped with the
 * npm package (`files: ["dist"]`). Before the ADB backend runs `am instrument`
 * it must guarantee that the package on the device is OUR helper — not a
 * malicious app squatting the package name. Package name and versionCode are
 * attacker-controlled metadata; the only trust anchor is the signing
 * certificate. So `ensureHelperTrusted` installs/upgrades by versionCode
 * (freshness only) and then UNCONDITIONALLY verifies the installed APK's v2/v3
 * signer against the pinned SHA-256 from the build manifest. A mismatch throws
 * {@link UntrustedHelperError} and the caller must fail closed (no dump
 * fallback) — see `adb-backend.ts`.
 *
 * `__dirname` is used for path resolution because it is portable across the
 * dual ESM/CJS build: ts-bridge rewrites it to an `import.meta.url`-based shim
 * in the `.mjs` output and leaves the native binding in the `.cjs` output.
 *
 * Version/policy/signer-verify flow adapted from agent-device (MIT, Copyright
 * (c) Callstack) onto our source-built APK and pure-JS signer verifier.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { createAndroidAdbExecutor } from './adb.js';
import { loadHelperArtifact } from './artifact.js';
import type { HelperArtifact } from './artifact.js';
import { UntrustedHelperError } from './errors.js';
import { assertApkSignerSha256 } from './signer.js';
import { HELPER_PACKAGE } from './snapshot.js';
import { exec } from '../../utils/exec.js';
import { createPrivateTempDir } from '../../utils/output-path.js';

const INSTALL_TIMEOUT_MS = 60_000;

const QUERY_TIMEOUT_MS = 10_000;

const PULL_TIMEOUT_MS = 30_000;

/**
 * `am instrument` prints this when the target instrumentation is not installed.
 * The ADB backend keys reactive re-installs off this signature.
 */
export const INSTRUMENTATION_NOT_FOUND_SIGNATURE = 'INSTRUMENTATION_FAILED';

/**
 * Resolve the path to the bundled helper APK (validated against its manifest).
 *
 * @returns The absolute path to the APK.
 * @throws When the bundled artifact is missing, malformed, or its digest does
 * not match the manifest.
 */
export async function resolveHelperApkPath(): Promise<string> {
  const artifact = await loadHelperArtifact();
  return artifact.apkPath;
}

/**
 * Check whether the helper package is present on the device.
 *
 * @param serial - The target device serial.
 * @returns True when the helper package is installed (any signer).
 */
export async function isHelperInstalled(serial: string): Promise<boolean> {
  const result = await exec(
    'adb',
    ['-s', serial, 'shell', 'pm', 'list', 'packages', HELPER_PACKAGE],
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  return result.stdout.includes(`package:${HELPER_PACKAGE}`);
}

/**
 * Read the installed helper's versionCode via `dumpsys package`.
 *
 * versionCode is attacker-controlled metadata: it is used ONLY to decide
 * whether to (re)install a fresher build, never as a trust signal.
 *
 * @param serial - The target device serial.
 * @returns The installed versionCode, or null when not installed / unreadable.
 */
async function readInstalledVersionCode(
  serial: string,
): Promise<number | null> {
  const result = await exec(
    'adb',
    ['-s', serial, 'shell', 'dumpsys', 'package', HELPER_PACKAGE],
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  const match = /versionCode=(\d+)/u.exec(result.stdout);
  return match ? Number(match[1]) : null;
}

/**
 * Install the bundled helper APK onto the device.
 *
 * `-r` reinstalls over an existing copy signed by the SAME key and `-t` allows
 * the `testOnly` APK. It CANNOT overwrite a package signed by a different key
 * (Android returns `INSTALL_FAILED_UPDATE_INCOMPATIBLE`); that case is handled
 * by `ensureHelperTrusted` failing closed.
 *
 * @param serial - The target device serial.
 * @throws When the install command fails.
 */
export async function installHelper(serial: string): Promise<void> {
  const apkPath = await resolveHelperApkPath();
  const result = await exec(
    'adb',
    ['-s', serial, 'install', '-r', '-t', apkPath],
    { timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (result.exitCode !== 0 || !result.stdout.includes('Success')) {
    const output = `${result.stdout.trim()} ${result.stderr.trim()}`.trim();
    throw new Error(
      `Failed to install snapshot helper APK (${apkPath}).\n${output}`,
    );
  }
}

/**
 * Pull every installed APK path for the helper package (base + splits) into a
 * private temp dir and verify each is signed by the pinned certificate.
 *
 * @param serial - The target device serial.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256.
 * @throws {@link UntrustedHelperError} when the installed signer does not match
 * the pin.
 */
async function verifyInstalledSigner(
  serial: string,
  artifact: HelperArtifact,
): Promise<void> {
  const run = createAndroidAdbExecutor(serial);
  const pathsResult = await run(['shell', 'pm', 'path', HELPER_PACKAGE], {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  const remotePaths = pathsResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('package:'))
    .map((line) => line.slice('package:'.length));
  if (remotePaths.length === 0) {
    throw new UntrustedHelperError(
      'Snapshot helper is installed but its APK path could not be resolved',
      { expectedSignerSha256: artifact.signerSha256 },
    );
  }

  const tempDir = createPrivateTempDir('helper-verify');
  try {
    let index = 0;
    for (const remotePath of remotePaths) {
      const localPath = join(tempDir, `apk-${index}.apk`);
      index += 1;
      const pull = await run(['pull', remotePath, localPath], {
        timeoutMs: PULL_TIMEOUT_MS,
      });
      if (pull.exitCode !== 0) {
        throw new UntrustedHelperError(
          `Could not pull installed helper APK for verification (${remotePath})`,
          { expectedSignerSha256: artifact.signerSha256 },
        );
      }
      await assertApkSignerSha256(localPath, artifact.signerSha256);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Ensure a TRUSTED helper is installed: install/upgrade by versionCode
 * (freshness), then unconditionally verify the installed signer against the
 * pinned certificate. Fails closed on a signer mismatch.
 *
 * @param serial - The target device serial.
 * @throws {@link UntrustedHelperError} when the installed helper is signed by
 * an unexpected certificate (a squatter). The caller MUST NOT fall back to
 * `uiautomator dump` in that case.
 * @throws When install fails for a generic reason.
 */
export async function ensureHelperTrusted(serial: string): Promise<void> {
  const artifact = await loadHelperArtifact();
  const installedVersion = await readInstalledVersionCode(serial);

  if (installedVersion === null || installedVersion < artifact.versionCode) {
    await installHelper(serial);
  }

  await verifyInstalledSigner(serial, artifact);
}
