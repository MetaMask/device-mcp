/* eslint-disable n/no-process-env -- the test drives build-android-helper.sh via HOME-based keystore paths and env */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';

import { SnapshotHelperError } from './errors.js';
import { assertApkSignerSha256, verifyApkSignerSha256 } from './signer.js';

const repoRoot = process.cwd();
const buildScript = join(repoRoot, 'scripts', 'build-android-helper.sh');
const home = process.env.HOME ?? '';
const sharedKeystore = join(home, '.device-mcp', 'helper.keystore');
const sharedPassFile = join(home, '.device-mcp', 'helper.pass');

const sdkRoot =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(home, 'Library', 'Android', 'sdk');

// The build script only needs the Android SDK (it self-generates a throwaway
// signing key when the shared keystore is absent). This gate lets the
// provenance-integrity test run in CI, where the SDK is present but the shared
// keystore secret is not.
const sdkOnlyAvailable =
  existsSync(buildScript) &&
  existsSync(join(sdkRoot, 'platforms', 'android-36', 'android.jar'));

const sdkAvailable =
  sdkOnlyAvailable && existsSync(sharedKeystore) && existsSync(sharedPassFile);

const PINNED_SIGNER_SHA256 =
  '0554218930d76c296dc6099049cb1659180acdd64ad59ee6e4b0548bcdd7641f';

type BuiltApk = { apkPath: string; expectedSignerSha256: string };

const buildApk = (outDir: string, useSharedKey: boolean): BuiltApk => {
  const version = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).version as string;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (useSharedKey) {
    env.DEVICE_MCP_HELPER_KEYSTORE = sharedKeystore;
    env.DEVICE_MCP_HELPER_KEYSTORE_PASSWORD = readFileSync(
      sharedPassFile,
      'utf8',
    );
    env.DEVICE_MCP_HELPER_KEY_ALIAS = 'device-mcp-helper';
  } else {
    delete env.DEVICE_MCP_HELPER_KEYSTORE;
    delete env.DEVICE_MCP_HELPER_KEYSTORE_PASSWORD;
    delete env.DEVICE_MCP_HELPER_KEY_ALIAS;
  }
  execFileSync('bash', [buildScript, version, outDir], { env, stdio: 'pipe' });
  const manifestName = `device-mcp-android-snapshot-helper-${version}.manifest.json`;
  const manifest = JSON.parse(readFileSync(join(outDir, manifestName), 'utf8'));
  return {
    apkPath: join(outDir, manifest.assetName as string),
    expectedSignerSha256: manifest.signerSha256 as string,
  };
};

describe('android snapshot-helper signer verification', () => {
  let signedApk: BuiltApk | undefined;
  let throwawayApk: BuiltApk | undefined;
  let workDir: string | undefined;

  beforeAll(() => {
    if (!sdkAvailable) {
      return;
    }
    workDir = mkdtempSync(join(tmpdir(), 'signer-test-'));
    signedApk = buildApk(join(workDir, 'shared'), true);
    throwawayApk = buildApk(join(workDir, 'throwaway'), false);
  }, 180_000);

  afterAll(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  describe('verifyApkSignerSha256', () => {
    it.skipIf(!sdkAvailable)(
      'verifies our real APK and returns the pinned signer SHA-256',
      async () => {
        const built = signedApk as BuiltApk;
        const result = await verifyApkSignerSha256(built.apkPath);
        expect(result.verified).toBe(true);
        expect(result.signerSha256).toBe(built.expectedSignerSha256);
        expect(result.signerSha256).toBe(PINNED_SIGNER_SHA256);
        expect(result.scheme === 'v2' || result.scheme === 'v3').toBe(true);
      },
    );

    it.skipIf(!sdkAvailable)(
      'reads the real signer, so a different key yields a different SHA',
      async () => {
        const shared = signedApk as BuiltApk;
        const other = throwawayApk as BuiltApk;
        const otherResult = await verifyApkSignerSha256(other.apkPath);
        expect(otherResult.signerSha256).not.toBe(shared.expectedSignerSha256);
      },
    );

    it('rejects a file with no signing block', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'signer-neg-'));
      try {
        const bogus = join(dir, 'not-an-apk.bin');
        execFileSync('bash', ['-c', `head -c 1024 /dev/zero > "${bogus}"`]);
        await expect(verifyApkSignerSha256(bogus)).rejects.toBeInstanceOf(
          SnapshotHelperError,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('assertApkSignerSha256', () => {
    it.skipIf(!sdkAvailable)(
      'passes when the signer matches the pin',
      async () => {
        const built = signedApk as BuiltApk;
        const outcome = await assertApkSignerSha256(
          built.apkPath,
          built.expectedSignerSha256,
        );
        expect(outcome).toBeUndefined();
      },
    );

    it.skipIf(!sdkAvailable)(
      'throws UntrustedHelperError when the signer does not match',
      async () => {
        const built = signedApk as BuiltApk;
        const wrong = 'dead'.repeat(16);
        await expect(
          assertApkSignerSha256(built.apkPath, wrong),
        ).rejects.toMatchObject({
          name: 'UntrustedHelperError',
          expectedSignerSha256: wrong,
          actualSignerSha256: built.expectedSignerSha256,
        });
      },
    );
  });
});

// Provenance-integrity: runs whenever the Android SDK is present (including CI,
// via a throwaway key), NOT gated on the shared keystore. This is the guard that
// would have caught the 0.4.0 bug where a build-tools apksigner format change
// produced a corrupt `signerSha256` ('cefcaea256de') in the manifest.
describe('build-android-helper manifest provenance', () => {
  let workDir: string | undefined;
  let built: BuiltApk | undefined;

  beforeAll(() => {
    if (!sdkOnlyAvailable) {
      return;
    }
    workDir = mkdtempSync(join(tmpdir(), 'provenance-test-'));
    built = buildApk(join(workDir, 'throwaway'), false);
  }, 180_000);

  afterAll(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!sdkOnlyAvailable)(
    'emits a well-formed 64-char hex signerSha256 in the manifest',
    () => {
      const { expectedSignerSha256 } = built as BuiltApk;
      expect(expectedSignerSha256).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  it.skipIf(!sdkOnlyAvailable)(
    'manifest signerSha256 matches the APK actual signer (producer == consumer)',
    async () => {
      const artifact = built as BuiltApk;
      const result = await verifyApkSignerSha256(artifact.apkPath);
      expect(result.verified).toBe(true);
      expect(result.signerSha256).toBe(artifact.expectedSignerSha256);
    },
  );
});
