import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { loadHelperArtifact } from './artifact.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);

const VERSION = '0.3.3';
const MANIFEST_NAME = `device-mcp-android-snapshot-helper-${VERSION}.manifest.json`;
const APK_NAME = `device-mcp-android-snapshot-helper-${VERSION}.apk`;
const APK_BYTES = Buffer.from('fake-apk-contents');
const APK_SHA256 = createHash('sha256').update(APK_BYTES).digest('hex');

const asDirEntries = (names: string[]): Awaited<ReturnType<typeof readdir>> =>
  names as unknown as Awaited<ReturnType<typeof readdir>>;

const validManifest = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: VERSION,
    versionCode: 3003,
    packageName: 'io.metamask.devicemcp.snapshothelper',
    instrumentationRunner:
      'io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation',
    assetName: APK_NAME,
    sha256: APK_SHA256,
    signerSha256:
      '0554218930d76c296dc6099049cb1659180acdd64ad59ee6e4b0548bcdd7641f',
    minSdk: 23,
    ...overrides,
  });

const wireFs = (manifestJson: string, apkBytes: Buffer = APK_BYTES): void => {
  mockReaddir.mockResolvedValue(asDirEntries([MANIFEST_NAME, APK_NAME]));
  mockReadFile.mockImplementation(async (path) => {
    const asString =
      typeof path === 'string'
        ? path
        : (path as { toString(): string }).toString();
    if (asString.endsWith('.manifest.json')) {
      return manifestJson;
    }
    return apkBytes;
  });
};

describe('loadHelperArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses a valid manifest and resolves the APK path', async () => {
    wireFs(validManifest());

    const artifact = await loadHelperArtifact();

    expect(artifact.versionCode).toBe(3003);
    expect(artifact.packageName).toBe('io.metamask.devicemcp.snapshothelper');
    expect(artifact.signerSha256).toBe(
      '0554218930d76c296dc6099049cb1659180acdd64ad59ee6e4b0548bcdd7641f',
    );
    expect(artifact.apkPath).toMatch(new RegExp(`${APK_NAME}$`, 'u'));
    expect(artifact.sha256).toBe(APK_SHA256);
  });

  // Regression guard: the module lives at
  // dist/backends/android-instrumentation/artifact.mjs, so the helper APK dir
  // must resolve two levels up to dist/android — NOT backends/android. When the
  // file was moved into a subfolder without adjusting the __dirname depth this
  // pointed at a non-existent dist/backends/android and every real snapshot
  // failed even though the mocked unit tests still passed.
  it('resolves the helper dir to a sibling of backends, not inside it', async () => {
    wireFs(validManifest());

    await loadHelperArtifact();

    const readdirArg = String(mockReaddir.mock.calls[0]?.[0]);
    expect(readdirArg).toMatch(/[\\/]android$/u);
    expect(readdirArg).not.toMatch(/[\\/]backends[\\/]android$/u);
    expect(readdirArg).not.toMatch(/android-instrumentation[\\/]/u);
  });

  it('throws when the helper directory is missing', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    await expect(loadHelperArtifact()).rejects.toThrow(
      /Snapshot helper directory is missing/u,
    );
  });

  it('throws when no manifest is present', async () => {
    mockReaddir.mockResolvedValue(asDirEntries(['readme.md']));

    await expect(loadHelperArtifact()).rejects.toThrow(
      /No snapshot helper manifest found/u,
    );
  });

  it('rejects a manifest for a different package', async () => {
    wireFs(validManifest({ packageName: 'com.evil.squatter' }));

    await expect(loadHelperArtifact()).rejects.toThrow(
      /does not match the expected/u,
    );
  });

  it('rejects when the APK digest does not match the manifest', async () => {
    wireFs(validManifest({ sha256: 'a'.repeat(64) }));

    await expect(loadHelperArtifact()).rejects.toThrow(
      /digest does not match its manifest/u,
    );
  });

  it('rejects a manifest missing a required field', async () => {
    wireFs(validManifest({ signerSha256: undefined }));

    await expect(loadHelperArtifact()).rejects.toThrow(
      /signerSha256.*missing or not a string/u,
    );
  });

  it('rejects malformed JSON', async () => {
    mockReaddir.mockResolvedValue(asDirEntries([MANIFEST_NAME, APK_NAME]));
    mockReadFile.mockResolvedValue('{ not json');

    await expect(loadHelperArtifact()).rejects.toThrow(/not valid JSON/u);
  });
});
