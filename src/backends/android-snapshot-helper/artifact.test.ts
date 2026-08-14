import { describe, it, expect } from 'vitest';

import {
  parseAndroidSnapshotHelperManifest,
  verifyAndroidSnapshotHelperArtifact,
} from './artifact.js';
import { resolveBundledAndroidSnapshotHelper } from './index.js';

const VALID = {
  name: 'android-snapshot-helper',
  version: '0.14.9',
  releaseTag: 'v0.14.9',
  assetName: 'agent-device-android-snapshot-helper-0.14.9.apk',
  apkUrl: null,
  sha256: '6dfb064793721b49e6111162a428f312bc9365dfc06e05adb648c434105fdf4e',
  expectedSignerSha256:
    'f5dc3a7bf83a1b17312c222cd89a2f781230f34a7a407e6033fa28adf0b3cf48',
  checksumName: 'agent-device-android-snapshot-helper-0.14.9.apk.sha256',
  packageName: 'com.callstack.agentdevice.snapshothelper',
  versionCode: 14009,
  instrumentationRunner:
    'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  minSdk: 23,
  targetSdk: 36,
  outputFormat: 'uiautomator-xml',
  statusProtocol: 'android-snapshot-helper-v1',
  installArgs: ['install', '-r', '-t'],
};

describe('parseAndroidSnapshotHelperManifest', () => {
  it('parses a valid manifest', () => {
    expect(parseAndroidSnapshotHelperManifest(VALID)).toStrictEqual({
      ...VALID,
      sha256: VALID.sha256,
    });
  });

  it('rejects a non-object', () => {
    expect(() => parseAndroidSnapshotHelperManifest(null)).toThrow(
      'must be an object',
    );
  });

  it('rejects a mismatched output format literal', () => {
    expect(() =>
      parseAndroidSnapshotHelperManifest({ ...VALID, outputFormat: 'json' }),
    ).toThrow('outputFormat');
  });

  it('rejects a malformed sha256', () => {
    expect(() =>
      parseAndroidSnapshotHelperManifest({ ...VALID, sha256: 'nope' }),
    ).toThrow('sha256');
  });

  it('rejects a missing or malformed expectedSignerSha256', () => {
    const { expectedSignerSha256: _missing, ...missingSigner } = VALID;
    expect(() => parseAndroidSnapshotHelperManifest(missingSigner)).toThrow(
      'expectedSignerSha256',
    );
    expect(() =>
      parseAndroidSnapshotHelperManifest({
        ...VALID,
        expectedSignerSha256: 'nope',
      }),
    ).toThrow('expectedSignerSha256');
  });

  it('rejects installArgs that do not start with install', () => {
    expect(() =>
      parseAndroidSnapshotHelperManifest({
        ...VALID,
        installArgs: ['-r', '-t'],
      }),
    ).toThrow('installArgs');
  });

  it('rejects installArgs with a flag outside the allowlist', () => {
    expect(() =>
      parseAndroidSnapshotHelperManifest({
        ...VALID,
        installArgs: ['install', '-r', '--force'],
      }),
    ).toThrow('installArgs');
  });
});

describe('verifyAndroidSnapshotHelperArtifact (bundled asset)', () => {
  it('verifies the checksum of the bundled APK matches its manifest', async () => {
    const artifact = resolveBundledAndroidSnapshotHelper();
    expect(await verifyAndroidSnapshotHelperArtifact(artifact)).toBeUndefined();
  });
});
