/**
 * Locates and installs the bundled Android snapshot-helper instrumentation APK.
 *
 * The APK is built during `prepack` into `dist/android/` and shipped with the
 * npm package (`files: ["dist"]`). At runtime the ADB backend needs to (a) find
 * that APK relative to the compiled JS and (b) make sure it is installed on the
 * target device before invoking `am instrument`.
 *
 * `__dirname` is used for path resolution because it is portable across the
 * dual ESM/CJS build: ts-bridge rewrites it to an `import.meta.url`-based shim
 * in the `.mjs` output and leaves the native binding in the `.cjs` output.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { HELPER_PACKAGE } from './android-instrumentation-snapshot.js';
import { exec } from '../utils/exec.js';

/**
 * Directory that holds the bundled helper APK, relative to this module.
 *
 * This file compiles to `dist/backends/`, so the APK built into `dist/android/`
 * sits one level up.
 */
const HELPER_APK_DIR = join(__dirname, '..', 'android');

/** Prefix of the bundled APK filename (version suffix varies per release). */
const HELPER_APK_PREFIX = 'device-mcp-android-snapshot-helper-';

/** Installing an APK is a one-time cost that can exceed a single-capture budget. */
const INSTALL_TIMEOUT_MS = 60_000;

/** Package queries are cheap; keep them well under any snapshot deadline. */
const QUERY_TIMEOUT_MS = 10_000;

/**
 * `am instrument` prints this when the target instrumentation is not installed.
 * The ADB backend keys reactive re-installs off this signature.
 */
export const INSTRUMENTATION_NOT_FOUND_SIGNATURE = 'INSTRUMENTATION_FAILED';

/**
 * Resolve the path to the bundled helper APK.
 *
 * @returns The absolute path to the APK.
 * @throws If no matching APK is present in `dist/android/` (e.g. the package
 * was built without running the helper build step).
 */
export async function resolveHelperApkPath(): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(HELPER_APK_DIR);
  } catch {
    throw new Error(
      `Snapshot helper APK directory is missing (${HELPER_APK_DIR}). ` +
        'The package may have been built without the Android helper.',
    );
  }

  const apk = entries
    .filter(
      (name) => name.startsWith(HELPER_APK_PREFIX) && name.endsWith('.apk'),
    )
    .sort()
    .at(-1);

  if (!apk) {
    throw new Error(
      `No snapshot helper APK found in ${HELPER_APK_DIR}. ` +
        'The package may have been built without the Android helper.',
    );
  }

  return join(HELPER_APK_DIR, apk);
}

/**
 * Check whether the helper package is installed on the device.
 *
 * @param serial - The target device serial.
 * @returns True when the helper package is present.
 */
export async function isHelperInstalled(serial: string): Promise<boolean> {
  const result = await exec(
    'adb',
    ['-s', serial, 'shell', 'pm', 'list', 'packages', HELPER_PACKAGE],
    { timeoutMs: QUERY_TIMEOUT_MS },
  );
  // `pm list packages <pkg>` matches substrings, so confirm the exact package.
  return result.stdout.includes(`package:${HELPER_PACKAGE}`);
}

/**
 * Install the bundled helper APK onto the device.
 *
 * `-r` reinstalls over any existing copy and `-t` allows the `testOnly` APK.
 *
 * @param serial - The target device serial.
 * @throws If the install command fails.
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
