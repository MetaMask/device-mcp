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

const sdkAvailable =
  existsSync(buildScript) &&
  existsSync(sharedKeystore) &&
  existsSync(sharedPassFile);

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
