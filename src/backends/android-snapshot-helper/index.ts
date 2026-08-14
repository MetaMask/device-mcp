import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseAndroidSnapshotHelperManifest } from './artifact.js';
import type { AndroidSnapshotHelperArtifact } from './types.js';

export { SnapshotHelperError } from './errors.js';
export type { SnapshotHelperErrorCode } from './errors.js';
export { captureAndroidSnapshotWithHelper } from './capture.js';
export { ensureAndroidSnapshotHelper } from './install.js';
export {
  parseAndroidSnapshotHelperManifest,
  verifyAndroidSnapshotHelperArtifact,
} from './artifact.js';
export { computeApkV1SignerSha256 } from './signer.js';
export type { ApksignerDependencies } from './signer.js';
export * from './types.js';

const BUNDLED_HELPER_VERSION = '0.14.9';

// ts-bridge's ESM shim percent-encodes URL pathnames; native CJS __dirname is not.
/* istanbul ignore next */
const HELPER_DIR =
  typeof require === 'undefined' ? decodeURIComponent(__dirname) : __dirname;
const VENDOR_DIR = join(HELPER_DIR, 'vendor');
const MANIFEST_PATH = join(
  VENDOR_DIR,
  `agent-device-android-snapshot-helper-${BUNDLED_HELPER_VERSION}.manifest.json`,
);

let cachedArtifact: AndroidSnapshotHelperArtifact | undefined;

export function resolveBundledAndroidSnapshotHelper(): AndroidSnapshotHelperArtifact {
  if (cachedArtifact) {
    return cachedArtifact;
  }
  const manifest = parseAndroidSnapshotHelperManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')),
  );
  const assetName =
    manifest.assetName ??
    `agent-device-android-snapshot-helper-${manifest.version}.apk`;
  cachedArtifact = {
    manifest,
    apkPath: join(VENDOR_DIR, assetName),
  };
  return cachedArtifact;
}
