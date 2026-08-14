import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  computeApkV1SignerSha256,
  resolveBundledAndroidSnapshotHelper,
} from './index.js';

const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_LOCAL_FILE = 0x04034b50;
const MAX_APK_BYTES = 100 * 1024 * 1024;

type ZipEntry = {
  name: string;
  data: Buffer;
  compression?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  localSignature?: number;
};

function buildApk(
  entries: ZipEntry[],
  centralDirectorySignature = ZIP_CENTRAL_DIRECTORY,
): Buffer {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compression = entry.compression ?? 0;
    const compressedSize = entry.compressedSize ?? entry.data.length;
    const uncompressedSize = entry.uncompressedSize ?? entry.data.length;
    const local = Buffer.alloc(30 + name.length + entry.data.length);
    local.writeUInt32LE(entry.localSignature ?? ZIP_LOCAL_FILE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compression, 8);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    entry.data.copy(local, 30 + name.length);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(centralDirectorySignature, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compression, 10);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);

    localRecords.push(local);
    centralRecords.push(central);
    localOffset += local.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

function signatureApk(data: Buffer, overrides: Partial<ZipEntry> = {}): Buffer {
  return buildApk([
    {
      name: 'META-INF/CERT.RSA',
      data,
      ...overrides,
    },
  ]);
}

let tempDirectory: string | undefined;
let fileIndex = 0;

function writeApk(apk: Buffer): string {
  tempDirectory ??= mkdtempSync(join(tmpdir(), 'device-mcp-signer-test-'));
  const path = join(tempDirectory, `${fileIndex}.apk`);
  fileIndex += 1;
  writeFileSync(path, apk);
  return path;
}

describe('computeApkV1SignerSha256', () => {
  afterEach(() => {
    if (tempDirectory) {
      rmSync(tempDirectory, { recursive: true, force: true });
      tempDirectory = undefined;
    }
  });

  it('computes the manifest signer from the bundled APK', async () => {
    const artifact = resolveBundledAndroidSnapshotHelper();

    expect(await computeApkV1SignerSha256(artifact.apkPath)).toBe(
      artifact.manifest.expectedSignerSha256,
    );
  });

  it('rejects an APK that exceeds the maximum supported size', async () => {
    const path = writeApk(Buffer.alloc(1));
    truncateSync(path, MAX_APK_BYTES + 1);

    await expect(computeApkV1SignerSha256(path)).rejects.toThrow(
      /maximum supported size/u,
    );
  });

  it('rejects an APK with no end-of-central-directory record', async () => {
    await expect(
      computeApkV1SignerSha256(writeApk(Buffer.alloc(22))),
    ).rejects.toThrow(/no ZIP end-of-central-directory record/u);
  });

  it('rejects an invalid central-directory signature', async () => {
    const apk = buildApk(
      [{ name: 'classes.dex', data: Buffer.alloc(0) }],
      0xdeadbeef,
    );

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /invalid ZIP central directory/u,
    );
  });

  it('rejects an APK with no v1 signing certificate block', async () => {
    const apk = buildApk([{ name: 'classes.dex', data: Buffer.alloc(0) }]);

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /no v1 signing certificate block/u,
    );
  });

  it('rejects an oversized declared signing block before reading its data', async () => {
    const apk = signatureApk(Buffer.alloc(1), {
      uncompressedSize: 10 * 1024 * 1024 + 1,
    });

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /signing certificate block is unexpectedly large/u,
    );
  });

  it('rejects an invalid local-file header signature', async () => {
    const apk = signatureApk(Buffer.alloc(0), {
      localSignature: 0xdeadbeef,
    });

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /invalid ZIP local-file header/u,
    );
  });

  it('rejects an unsupported ZIP compression method', async () => {
    const apk = signatureApk(Buffer.alloc(0), { compression: 99 });

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /signing certificate block has invalid compression/u,
    );
  });

  it('rejects a central-directory name that exceeds APK bounds', async () => {
    const apk = signatureApk(Buffer.alloc(0));
    const eocdOffset = apk.length - 22;
    const centralDirectoryOffset = apk.readUInt32LE(eocdOffset + 16);
    apk.writeUInt16LE(0xffff, centralDirectoryOffset + 28);

    await expect(computeApkV1SignerSha256(writeApk(apk))).rejects.toThrow(
      /ZIP entry name exceeds APK bounds/u,
    );
  });

  it.each([
    [
      'non-ContentInfo DER',
      Buffer.from('3100', 'hex'),
      /not DER PKCS#7 ContentInfo/u,
    ],
    [
      'non-SignedData ContentInfo',
      Buffer.from('3000', 'hex'),
      /not PKCS#7 SignedData/u,
    ],
    ['truncated DER', Buffer.from('30', 'hex'), /Truncated DER element/u],
    [
      'high-tag-number DER',
      Buffer.from('1f00', 'hex'),
      /Unsupported high-tag-number DER element/u,
    ],
    ['invalid DER length', Buffer.from('3080', 'hex'), /Invalid DER length/u],
  ])('rejects %s', async (_description, der, message) => {
    await expect(
      computeApkV1SignerSha256(writeApk(signatureApk(der))),
    ).rejects.toThrow(message);
  });

  it('rejects malformed explicit PKCS#7 SignedData', async () => {
    const der = Buffer.from('300d06092a864886f70d010702a000', 'hex');

    await expect(
      computeApkV1SignerSha256(writeApk(signatureApk(der))),
    ).rejects.toThrow(/invalid PKCS#7 SignedData/u);
  });

  it('rejects PKCS#7 SignedData without certificates', async () => {
    const der = Buffer.from(
      '301706092a864886f70d010702a00a30080500050005000500',
      'hex',
    );

    await expect(
      computeApkV1SignerSha256(writeApk(signatureApk(der))),
    ).rejects.toThrow(/SignedData contains no certificates/u);
  });

  it('rejects PKCS#7 SignedData that identifies no leaf certificate', async () => {
    // This exercises the permitted multi-signer decision sub-path without
    // introducing two unrelated valid X.509 certificate fixtures.
    const der = Buffer.from(
      '301706092a864886f70d010702a00a3008050005000500a000',
      'hex',
    );

    await expect(
      computeApkV1SignerSha256(writeApk(signatureApk(der))),
    ).rejects.toThrow(/does not identify exactly one leaf certificate/u);
  });
});
