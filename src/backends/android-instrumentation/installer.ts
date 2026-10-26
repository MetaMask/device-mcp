/**
 * Install the bundled helper by versionCode (freshness), then verify the
 * installed signer against the manifest pin (trust). Package name and version
 * are attacker-controlled; neither establishes trust.
 *
 * Version/policy/signer-verify flow adapted from agent-device (MIT, Copyright
 * (c) Callstack) onto our source-built APK and pure-JS signer verifier.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { createAndroidAdbExecutor } from './adb.js';
import type { AndroidAdbExecutor } from './adb.js';
import { loadHelperArtifact } from './artifact.js';
import type { HelperArtifact } from './artifact.js';
import {
  HelperNotInstalledError,
  isHelperNotInstalledError,
  isUntrustedHelperError,
  UNTRUSTED_HELPER_REMEDY,
  UntrustedHelperError,
} from './errors.js';
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
 * `-r` replaces a same-key install; `-t` allows the `testOnly` APK. If install
 * fails, verify any remaining package before permitting dump fallback. Trust
 * depends on the installed signer, not Android's install-error text.
 *
 * @param serial - The target device serial.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256,
 * used both to locate the APK and to describe a trust failure.
 * @throws {@link UntrustedHelperError} when install fails and the remaining
 * package has a different signer or its trust cannot be verified.
 * @throws The install error when the remaining package is trusted or absent.
 */
export async function installHelper(
  serial: string,
  artifact?: HelperArtifact,
): Promise<void> {
  const resolved = artifact ?? (await loadHelperArtifact());
  const { apkPath } = resolved;
  try {
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
  } catch (installError) {
    try {
      await verifyInstalledSigner(serial, resolved);
    } catch (error) {
      if (isUntrustedHelperError(error)) {
        throw error;
      }
      if (!isHelperNotInstalledError(error)) {
        throw new UntrustedHelperError(
          `Snapshot helper install failed and the installed package could not ` +
            `be verified. ${String(installError)}\n${UNTRUSTED_HELPER_REMEDY}`,
          { expectedSignerSha256: resolved.signerSha256 },
          { cause: error },
        );
      }
    }
    throw installError;
  }
}

const MIN_SDK_FOR_PATH_CACHE = 26;

/**
 * Per-device cache of the signer pin and APK paths that passed verification.
 * `pm path` still runs before every use. API 26+ randomizes install directories,
 * so unchanged paths identify the same install. Earlier APIs can reuse paths.
 * Replacing bytes in place requires root, outside this threat model.
 */
export class HelperTrustCache {
  #verifiedKey: string | undefined;

  #sdkLevel: number | undefined;

  isVerified(key: string): boolean {
    return this.#verifiedKey === key;
  }

  /**
   * Call only after full verification on API 26+.
   *
   * @param key - The pin and APK paths of the verified install.
   */
  rememberVerified(key: string): void {
    this.#verifiedKey = key;
  }

  forget(): void {
    this.#verifiedKey = undefined;
  }

  /**
   * Cache successful API-level reads; retry failed reads on the next call.
   *
   * @param run - The device-scoped adb executor.
   * @returns The API level, or null when it could not be read.
   */
  async sdkLevel(run: AndroidAdbExecutor): Promise<number | null> {
    if (this.#sdkLevel !== undefined) {
      return this.#sdkLevel;
    }
    const result = await run(['shell', 'getprop', 'ro.build.version.sdk'], {
      timeoutMs: QUERY_TIMEOUT_MS,
    }).catch(() => null);
    const level = Number(result?.stdout.trim());
    if (result?.exitCode !== 0 || !Number.isInteger(level) || level <= 0) {
      return null;
    }
    this.#sdkLevel = level;
    return level;
  }
}

/**
 * Check installed APK paths on every call; pull and verify uncached installs.
 * See {@link HelperTrustCache} for the path-cache assumptions.
 *
 * @param serial - The target device serial.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256.
 * @param cache - Optional per-backend cache of the last verified install.
 * @throws {@link UntrustedHelperError} when the installed signer does not match
 * the pin.
 * @throws {@link HelperNotInstalledError} when the package list confirms the
 * helper is not installed (not a trust failure).
 */
export async function verifyInstalledSigner(
  serial: string,
  artifact: HelperArtifact,
  cache?: HelperTrustCache,
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
    cache?.forget();
    // `pm path` exits 1 for an absent package as well as some command failures.
    // Confirm absence before permitting reinstall or dump fallback.
    const packages = await run(
      ['shell', 'pm', 'list', 'packages', HELPER_PACKAGE],
      { timeoutMs: QUERY_TIMEOUT_MS },
    );
    const installed = packages.stdout
      .split('\n')
      .some((line) => line.trim() === `package:${HELPER_PACKAGE}`);
    if (packages.exitCode === 0 && !installed) {
      throw new HelperNotInstalledError(
        `Snapshot helper is not installed: \`pm path ${HELPER_PACKAGE}\` ` +
          'returned no APK path and the package list confirmed absence',
      );
    }
    throw new UntrustedHelperError(
      'Could not resolve installed helper APK paths for verification',
      { expectedSignerSha256: artifact.signerSha256 },
    );
  }
  if (pathsResult.exitCode !== 0) {
    cache?.forget();
    throw new UntrustedHelperError(
      'Could not query installed helper APK paths for verification',
      { expectedSignerSha256: artifact.signerSha256 },
    );
  }

  const key = [artifact.signerSha256, ...remotePaths].join('\n');
  if (cache?.isVerified(key)) {
    return;
  }
  // A failed verification must not leave a previous install cached.
  cache?.forget();

  await pullAndVerify(run, remotePaths, artifact);

  const sdkLevel = cache ? await cache.sdkLevel(run) : null;
  if (sdkLevel !== null && sdkLevel >= MIN_SDK_FOR_PATH_CACHE) {
    cache?.rememberVerified(key);
  }
}

/**
 * Pull each APK into a private temp dir and verify its signer against the pin.
 *
 * @param run - The device-scoped adb executor.
 * @param remotePaths - The installed APK paths from `pm path`.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256.
 * @throws {@link UntrustedHelperError} when a pull fails or a signer does not
 * match the pin.
 */
async function pullAndVerify(
  run: AndroidAdbExecutor,
  remotePaths: string[],
  artifact: HelperArtifact,
): Promise<void> {
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
 * Install/upgrade the bundled helper by versionCode (freshness only).
 *
 * versionCode is attacker-controlled metadata, so this is NOT a trust decision:
 * it only decides whether a fresher build should be pushed. Failed installs
 * verify the remaining package to classify the error. Callers MUST still call
 * {@link assertInstalledHelperTrusted} before every use of the helper.
 *
 * This is safe to gate behind a per-process "installed" cache because a stale
 * cache at worst skips a redundant (idempotent) install; it never skips a trust
 * check.
 *
 * @param serial - The target device serial.
 * @throws When install fails for a generic reason.
 */
export async function ensureHelperInstalled(serial: string): Promise<void> {
  const artifact = await loadHelperArtifact();
  const installedVersion = await readInstalledVersionCode(serial);

  if (installedVersion === null || installedVersion < artifact.versionCode) {
    await installHelper(serial, artifact);
  }
}

/**
 * Check trust before every `am instrument`, including retries. Never cache
 * this call: the installed package can change between invocations.
 *
 * @param serial - The target device serial.
 * @param cache - Optional per-backend cache of the last verified install.
 * @throws {@link UntrustedHelperError} when the installed helper is signed by
 * an unexpected certificate (a squatter). The caller MUST NOT fall back to
 * `uiautomator dump` in that case.
 * @throws {@link HelperNotInstalledError} when the helper package is not
 * installed (not a trust failure; reinstall and retry).
 */
export async function assertInstalledHelperTrusted(
  serial: string,
  cache?: HelperTrustCache,
): Promise<void> {
  const artifact = await loadHelperArtifact();
  await verifyInstalledSigner(serial, artifact, cache);
}

/**
 * Ensure a TRUSTED helper is installed: install/upgrade by versionCode
 * (freshness), then unconditionally verify the installed signer against the
 * pinned certificate. Fails closed on a signer mismatch.
 *
 * Convenience wrapper over {@link ensureHelperInstalled} +
 * {@link assertInstalledHelperTrusted}. Callers that cache the install step
 * MUST still call {@link assertInstalledHelperTrusted} on every use rather than
 * caching this whole call.
 *
 * @param serial - The target device serial.
 * @throws {@link UntrustedHelperError} when the installed helper is signed by
 * an unexpected certificate (a squatter). The caller MUST NOT fall back to
 * `uiautomator dump` in that case.
 * @throws When install fails for a generic reason.
 */
export async function ensureHelperTrusted(serial: string): Promise<void> {
  await ensureHelperInstalled(serial);
  await assertInstalledHelperTrusted(serial);
}
