// Derived from agent-device (MIT, Copyright (c) Callstack); adapted for our
// source-built helper APK and package constants.
/**
 * Reads and validates the provenance manifest that `build-android-helper.sh`
 * emits next to the bundled helper APK. The manifest is the single source of
 * truth for the package name, instrumentation runner, versionCode, the APK
 * file digest (a tamper check on `dist/`), and the pinned signer certificate
 * SHA-256 that the installed helper must match before we run `am instrument`.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SnapshotHelperError } from './errors.js';
import { HELPER_PACKAGE } from './snapshot.js';

// The compiled module lives at dist/backends/android-instrumentation/, so the
// bundled helper APK directory (dist/android) is two levels up.
const HELPER_APK_DIR = join(__dirname, '..', '..', 'android');

const HELPER_APK_PREFIX = 'device-mcp-android-snapshot-helper-';

const MANIFEST_SUFFIX = '.manifest.json';

export type HelperArtifact = {
  version: string;
  versionCode: number;
  packageName: string;
  instrumentationRunner: string;
  apkPath: string;
  sha256: string;
  signerSha256: string;
  minSdk: number;
};

/**
 * Raise an {@link SnapshotHelperError} for a missing or malformed artifact.
 *
 * @param message - What went wrong.
 * @throws Always.
 */
function invalid(message: string): never {
  throw new SnapshotHelperError('ARTIFACT_INVALID', message);
}

/**
 * Assert a manifest field is a non-empty string.
 *
 * @param value - The parsed field value.
 * @param field - The field name, for error messages.
 * @returns The value, narrowed to string.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`Helper manifest field "${field}" is missing or not a string`);
  }
  return value;
}

/**
 * Assert a manifest field is a finite non-negative integer.
 *
 * @param value - The parsed field value.
 * @param field - The field name, for error messages.
 * @returns The value, narrowed to number.
 */
function requireInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid(`Helper manifest field "${field}" is missing or not an integer`);
  }
  return value;
}

/**
 * Locate the helper manifest in the bundled `dist/android` directory.
 *
 * @returns The absolute path to the newest matching manifest.
 * @throws {@link SnapshotHelperError} when the directory or manifest is absent.
 */
async function resolveManifestPath(): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(HELPER_APK_DIR);
  } catch {
    return invalid(
      `Snapshot helper directory is missing (${HELPER_APK_DIR}). ` +
        'The package may have been built without the Android helper.',
    );
  }
  const manifest = entries
    .filter(
      (name) =>
        name.startsWith(HELPER_APK_PREFIX) && name.endsWith(MANIFEST_SUFFIX),
    )
    .sort()
    .at(-1);
  if (!manifest) {
    return invalid(
      `No snapshot helper manifest found in ${HELPER_APK_DIR}. ` +
        'The package may have been built without the Android helper.',
    );
  }
  return join(HELPER_APK_DIR, manifest);
}

/**
 * Compute the SHA-256 of a file as lowercase hex.
 *
 * @param path - The file to digest.
 * @returns The lowercase-hex SHA-256.
 */
async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Load and validate the bundled helper artifact: parse the manifest, confirm
 * it targets our package, resolve the APK path, and verify the APK's SHA-256
 * matches the manifest (a tamper check on the shipped `dist/`).
 *
 * @returns The validated artifact descriptor.
 * @throws {@link SnapshotHelperError} when anything is missing, malformed, or
 * the APK digest does not match the manifest.
 */
export async function loadHelperArtifact(): Promise<HelperArtifact> {
  const manifestPath = await resolveManifestPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return invalid(
      `Helper manifest is not valid JSON (${manifestPath}): ${String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return invalid(`Helper manifest is not an object (${manifestPath})`);
  }
  const manifest = parsed as Record<string, unknown>;

  const packageName = requireString(manifest.packageName, 'packageName');
  if (packageName !== HELPER_PACKAGE) {
    invalid(
      `Helper manifest packageName "${packageName}" does not match the ` +
        `expected "${HELPER_PACKAGE}"`,
    );
  }

  const assetName = requireString(manifest.assetName, 'assetName');
  const sha256 = requireString(manifest.sha256, 'sha256');
  const apkPath = join(HELPER_APK_DIR, assetName);

  const actualSha256 = await sha256File(apkPath).catch(() =>
    invalid(`Helper APK is missing or unreadable (${apkPath})`),
  );
  if (actualSha256 !== sha256.toLowerCase()) {
    invalid(
      `Helper APK digest does not match its manifest (${apkPath}). ` +
        'The bundled artifact may be corrupt or tampered with.',
    );
  }

  return {
    version: requireString(manifest.version, 'version'),
    versionCode: requireInt(manifest.versionCode, 'versionCode'),
    packageName,
    instrumentationRunner: requireString(
      manifest.instrumentationRunner,
      'instrumentationRunner',
    ),
    apkPath,
    sha256: sha256.toLowerCase(),
    signerSha256: requireString(
      manifest.signerSha256,
      'signerSha256',
    ).toLowerCase(),
    minSdk: requireInt(manifest.minSdk, 'minSdk'),
  };
}
