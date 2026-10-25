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
import type { AndroidAdbExecutor } from './adb.js';
import { loadHelperArtifact } from './artifact.js';
import type { HelperArtifact } from './artifact.js';
import {
  HelperNotInstalledError,
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
 * Android install-result tokens that specifically indicate the already-
 * installed same-package app was signed by a DIFFERENT certificate, so the
 * reinstall was refused on trust grounds (not a generic install failure). These
 * constant names are stable across API 23-35 and are printed by PackageManager
 * in the `Failure [<TOKEN>: ...]` line (on stdout; we scan both streams).
 *
 * Deliberately excludes generic failures like INSTALL_FAILED_TEST_ONLY,
 * INSTALL_FAILED_VERSION_DOWNGRADE, INSTALL_FAILED_DUPLICATE_PERMISSION, and
 * the parse-time no/inconsistent-certificate codes: none of those mean a
 * squatter is signed by a different key on a normal reinstall.
 */
const SIGNER_CONFLICT_TOKENS = [
  'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
  'INSTALL_FAILED_SHARED_USER_INCOMPATIBLE',
];

/**
 * Install the bundled helper APK onto the device.
 *
 * `-r` reinstalls over an existing copy signed by the SAME key and `-t` allows
 * the `testOnly` APK. It CANNOT overwrite a package signed by a different key:
 * Android refuses with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (or
 * `INSTALL_FAILED_SHARED_USER_INCOMPATIBLE`). That is a squatter signed by a
 * foreign certificate, so it is a TRUST failure, not a generic one — we throw
 * {@link UntrustedHelperError} to make the caller fail closed, consistent with
 * the equal/higher-versionCode squatter path (which fails closed via the signer
 * verification). Without this, a lower-versionCode squatter would surface as a
 * generic Error and `auto` mode would silently fall back to `uiautomator dump`.
 *
 * @param serial - The target device serial.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256,
 * used both to locate the APK and to describe a trust failure.
 * @throws {@link UntrustedHelperError} when the install is refused because the
 * installed package is signed by a different certificate.
 * @throws When the install command fails for a generic reason.
 */
export async function installHelper(
  serial: string,
  artifact?: HelperArtifact,
): Promise<void> {
  const resolved = artifact ?? (await loadHelperArtifact());
  const { apkPath } = resolved;
  const result = await exec(
    'adb',
    ['-s', serial, 'install', '-r', '-t', apkPath],
    { timeoutMs: INSTALL_TIMEOUT_MS },
  );
  if (result.exitCode !== 0 || !result.stdout.includes('Success')) {
    const output = `${result.stdout.trim()} ${result.stderr.trim()}`.trim();
    if (SIGNER_CONFLICT_TOKENS.some((token) => output.includes(token))) {
      throw new UntrustedHelperError(
        `Snapshot helper install was refused because the installed package is ` +
          `signed by a different certificate (a squatter). ${output}\n` +
          `${UNTRUSTED_HELPER_REMEDY}`,
        { expectedSignerSha256: resolved.signerSha256 },
      );
    }
    throw new Error(
      `Failed to install snapshot helper APK (${apkPath}).\n${output}`,
    );
  }
}

/**
 * The first API level (Android 8.0) where every install or update of a package
 * gets a new, randomized code directory: `/data/app/<pkg>-<random>/`, and
 * `/data/app/~~<random>/<pkg>-<random>/` from Android 11. Android 7 and earlier
 * alternate between `/data/app/<pkg>-1/` and `-2/`, so a path can repeat across
 * installs there and the path cache is not used.
 */
const MIN_SDK_FOR_PATH_CACHE = 26;

/**
 * Per-backend state that lets {@link verifyInstalledSigner} skip the pull and
 * hash when the helper install has not changed.
 *
 * This is NOT a cached trust decision. `pm path` still runs before every use,
 * and the cache only remembers which APK paths last passed full signer
 * verification against the pin. Android writes every install or update to a
 * new randomized directory, so the same paths mean the same install. Replacing
 * the APK bytes at an existing path requires root, which is outside the threat
 * model (root can also tamper with the helper process, `am`, or `adb` itself).
 *
 * Create one instance per device and pass the same instance on every call.
 */
export class HelperTrustCache {
  // The pin and APK paths that last passed full verification.
  #verifiedKey: string | undefined;

  // The device API level, once it has been read successfully.
  #sdkLevel: number | undefined;

  /**
   * @param key - The pin and APK paths of the current install.
   * @returns True when this exact install already passed full verification.
   */
  isVerified(key: string): boolean {
    return this.#verifiedKey === key;
  }

  /**
   * Remember an install that just passed full verification. Only call this
   * after a successful pull + hash, and only on API 26+.
   *
   * @param key - The pin and APK paths of the verified install.
   */
  rememberVerified(key: string): void {
    this.#verifiedKey = key;
  }

  /** Forget the verified install, so the next call verifies in full. */
  forget(): void {
    this.#verifiedKey = undefined;
  }

  /**
   * Read the device API level, once per cache. A failed read is not
   * remembered, so a transient adb error is retried on the next call.
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
 * Resolve the helper's installed APK paths (base + splits), then pull each one
 * into a private temp dir and verify it is signed by the pinned certificate.
 *
 * With a `cache`, `pm path` still runs on every call, but the pull and hash are
 * skipped when the paths are the same as the last successful verification and
 * the device is API {@link MIN_SDK_FOR_PATH_CACHE} or later. Any failure clears
 * the cache before it throws, so the next call verifies in full.
 *
 * @param serial - The target device serial.
 * @param artifact - The bundled artifact carrying the pinned signer SHA-256.
 * @param cache - Optional per-backend cache of the last verified install.
 * @throws {@link UntrustedHelperError} when the installed signer does not match
 * the pin.
 * @throws {@link HelperNotInstalledError} when the helper package is not
 * installed (not a trust failure).
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
    // No APK path means the package is not installed (for example it was
    // uninstalled mid-session). A missing package cannot run code, so this is
    // not a trust failure: the backend reinstalls the helper and retries, and
    // the fresh install is verified in full before `am instrument` runs.
    throw new HelperNotInstalledError(
      `Snapshot helper is not installed: \`pm path ${HELPER_PACKAGE}\` ` +
        'returned no APK path',
    );
  }

  // The key includes the pin, so a different bundled helper never matches.
  // A key is only remembered on API 26+ (see below), so a match is enough.
  const key = [artifact.signerSha256, ...remotePaths].join('\n');
  if (cache?.isVerified(key)) {
    return;
  }
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
 * it only decides whether a fresher build should be pushed. It performs NO
 * signer verification. Callers MUST separately call
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
 * Verify that the helper currently installed on the device is signed by the
 * pinned certificate. This is the trust invariant and MUST run before EVERY
 * `am instrument`, never cached as a boolean: package name and versionCode are
 * attacker-controlled, so an actor who can install packages could replace a
 * previously-trusted helper with a malicious same-package instrumentation
 * between snapshots. Re-checking the installed helper on every use is what
 * keeps the signature pin a per-use invariant instead of a one-time check.
 *
 * Without a `cache`, every call runs pm path + pull + hash. With a `cache`,
 * every call still runs `pm path`, and the pull + hash are skipped only when
 * the APK paths are the same as the last successful verification (see
 * {@link HelperTrustCache} for why that is safe on API 26+).
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
