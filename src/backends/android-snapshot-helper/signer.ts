import { createHash, X509Certificate } from 'node:crypto';
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { SnapshotHelperError } from './errors.js';
import type { AndroidAdbExecutor } from './types.js';
import { exec } from '../../utils/exec.js';
import { createPrivateTempDir } from '../../utils/output-path.js';

const APK_SIGNATURE_ENTRY = /^META-INF\/[^/]+\.(?:RSA|DSA|EC)$/iu;
const APK_SIGNER_DIGEST =
  /Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]+)/giu;
const PACKAGE_PATH_PREFIX = 'package:';
const PKCS7_SIGNED_DATA = Buffer.from('2a864886f70d010702', 'hex');
const ZIP_CENTRAL_DIRECTORY = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_MAX_COMMENT_LENGTH = 0xffff;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;
const MAX_SIGNATURE_BLOCK_BYTES = 10 * 1024 * 1024;
const MAX_APK_BYTES = 100 * 1024 * 1024;

type DerElement = {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
};

export async function verifyInstalledAndroidSnapshotHelperSigner(
  adb: AndroidAdbExecutor,
  packageName: string,
  expectedSignerSha256: string,
  timeoutMs: number,
): Promise<void> {
  const pathResult = await adb(['shell', 'pm', 'path', packageName], {
    allowFailure: true,
    timeoutMs,
  });
  const remoteApkPath = readFirstPackagePath(pathResult.stdout);
  if (pathResult.exitCode !== 0 || !remoteApkPath) {
    throw verificationFailed(
      packageName,
      'could not resolve installed APK path',
      {
        stdout: pathResult.stdout,
        stderr: pathResult.stderr,
        exitCode: pathResult.exitCode,
      },
    );
  }

  const tempDir = createPrivateTempDir('snapshot-helper-signer');
  const localApkPath = join(tempDir, 'base.apk');
  try {
    const pullResult = await adb(['pull', remoteApkPath, localApkPath], {
      allowFailure: true,
      timeoutMs,
    });
    if (pullResult.exitCode !== 0 || !isNonEmptyFile(localApkPath)) {
      throw verificationFailed(packageName, 'could not pull installed APK', {
        stdout: pullResult.stdout,
        stderr: pullResult.stderr,
        exitCode: pullResult.exitCode,
      });
    }

    const actualSignerSha256 = await computeApkV1SignerSha256(localApkPath);
    assertSignerMatches(
      packageName,
      expectedSignerSha256,
      actualSignerSha256,
      'v1 signing certificate',
    );

    const apksignerPath = resolveApksignerPath();
    if (apksignerPath) {
      await verifyWithApksigner(
        apksignerPath,
        localApkPath,
        packageName,
        expectedSignerSha256,
        timeoutMs,
      );
    }
  } catch (error: unknown) {
    if (error instanceof SnapshotHelperError) {
      throw error;
    }
    throw verificationFailed(
      packageName,
      'could not verify signing certificate',
      undefined,
      error,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function computeApkV1SignerSha256(
  apkPath: string,
): Promise<string> {
  if (statSync(apkPath).size > MAX_APK_BYTES) {
    throw new Error('APK exceeds maximum supported size');
  }
  const apk = readFileSync(apkPath);
  const signatureEntries = readApkSignatureEntries(apk);
  if (signatureEntries.length === 0) {
    throw new Error('APK contains no v1 signing certificate block');
  }

  const signerDigests = new Set<string>();
  for (const signatureBlock of signatureEntries) {
    const leaf = readPkcs7LeafCertificate(signatureBlock);
    signerDigests.add(createHash('sha256').update(leaf.raw).digest('hex'));
  }
  if (signerDigests.size !== 1) {
    throw new Error('APK contains multiple distinct v1 signers');
  }
  return [...signerDigests][0];
}

function readFirstPackagePath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PACKAGE_PATH_PREFIX)) {
      const path = trimmed.slice(PACKAGE_PATH_PREFIX.length).trim();
      if (path.length > 0) {
        return path;
      }
    }
  }
  return undefined;
}

function isNonEmptyFile(path: string): boolean {
  try {
    return statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function readApkSignatureEntries(apk: Buffer): Buffer[] {
  const eocdOffset = findEndOfCentralDirectory(apk);
  const entryCount = apk.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = apk.readUInt32LE(eocdOffset + 16);
  const entries: Buffer[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    assertRange(apk, offset, 46, 'ZIP central-directory entry');
    if (apk.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY) {
      throw new Error('APK has an invalid ZIP central directory');
    }
    const compression = apk.readUInt16LE(offset + 10);
    const compressedSize = apk.readUInt32LE(offset + 20);
    const uncompressedSize = apk.readUInt32LE(offset + 24);
    const nameLength = apk.readUInt16LE(offset + 28);
    const extraLength = apk.readUInt16LE(offset + 30);
    const commentLength = apk.readUInt16LE(offset + 32);
    const localHeaderOffset = apk.readUInt32LE(offset + 42);
    assertRange(apk, offset + 46, nameLength, 'ZIP entry name');
    const name = apk.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (APK_SIGNATURE_ENTRY.test(name)) {
      entries.push(
        readZipEntry(
          apk,
          localHeaderOffset,
          compression,
          compressedSize,
          uncompressedSize,
        ),
      );
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(apk: Buffer): number {
  const minimumOffset = Math.max(0, apk.length - ZIP_MAX_COMMENT_LENGTH - 22);
  for (let offset = apk.length - 22; offset >= minimumOffset; offset -= 1) {
    if (apk.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error('APK has no ZIP end-of-central-directory record');
}

function readZipEntry(
  apk: Buffer,
  localHeaderOffset: number,
  compression: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  if (uncompressedSize > MAX_SIGNATURE_BLOCK_BYTES) {
    throw new Error('APK signing certificate block is unexpectedly large');
  }
  assertRange(apk, localHeaderOffset, 30, 'ZIP local-file header');
  if (apk.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE) {
    throw new Error('APK has an invalid ZIP local-file header');
  }
  const nameLength = apk.readUInt16LE(localHeaderOffset + 26);
  const extraLength = apk.readUInt16LE(localHeaderOffset + 28);
  const dataOffset = localHeaderOffset + 30 + nameLength + extraLength;
  assertRange(apk, dataOffset, compressedSize, 'ZIP entry data');
  const compressed = apk.subarray(dataOffset, dataOffset + compressedSize);
  let result: Buffer;
  if (compression === ZIP_STORED) {
    result = Buffer.from(compressed);
  } else if (compression === ZIP_DEFLATED) {
    result = inflateRawSync(compressed, {
      maxOutputLength: MAX_SIGNATURE_BLOCK_BYTES,
    });
  } else {
    throw new Error('APK signing certificate block has invalid compression');
  }
  if (result.length !== uncompressedSize) {
    throw new Error('APK signing certificate block has invalid compression');
  }
  return result;
}

function assertRange(
  buffer: Buffer,
  offset: number,
  length: number,
  description: string,
): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new Error(`${description} exceeds APK bounds`);
  }
}

function readPkcs7LeafCertificate(block: Buffer): X509Certificate {
  const contentInfo = readDerElement(block, 0);
  if (contentInfo.tag !== 0x30 || contentInfo.end !== block.length) {
    throw new Error('APK signing block is not DER PKCS#7 ContentInfo');
  }
  const contentInfoChildren = readDerChildren(block, contentInfo);
  if (
    contentInfoChildren.length !== 2 ||
    contentInfoChildren[0].tag !== 0x06 ||
    !block
      .subarray(contentInfoChildren[0].contentStart, contentInfoChildren[0].end)
      .equals(PKCS7_SIGNED_DATA) ||
    contentInfoChildren[1].tag !== 0xa0
  ) {
    throw new Error('APK signing block is not PKCS#7 SignedData');
  }

  const explicitSignedData = readDerChildren(block, contentInfoChildren[1]);
  if (explicitSignedData.length !== 1 || explicitSignedData[0].tag !== 0x30) {
    throw new Error('APK signing block has invalid PKCS#7 SignedData');
  }
  const signedDataChildren = readDerChildren(block, explicitSignedData[0]);
  const certificateSet = signedDataChildren.find(
    (element, index) => index >= 3 && element.tag === 0xa0,
  );
  if (!certificateSet) {
    throw new Error('PKCS#7 SignedData contains no certificates');
  }

  const certificates: X509Certificate[] = [];
  for (const element of readDerChildren(block, certificateSet)) {
    if (element.tag === 0x30) {
      certificates.push(
        new X509Certificate(block.subarray(element.start, element.end)),
      );
    }
  }
  const leaves = certificates.filter(
    (candidate) =>
      !certificates.some(
        (other) => other !== candidate && other.issuer === candidate.subject,
      ),
  );
  if (leaves.length !== 1) {
    throw new Error(
      'PKCS#7 SignedData does not identify exactly one leaf certificate',
    );
  }
  return leaves[0];
}

function readDerChildren(buffer: Buffer, parent: DerElement): DerElement[] {
  const children: DerElement[] = [];
  let offset = parent.contentStart;
  while (offset < parent.end) {
    const child = readDerElement(buffer, offset);
    if (child.end > parent.end) {
      throw new Error('DER child exceeds its parent');
    }
    children.push(child);
    offset = child.end;
  }
  return children;
}

function readDerElement(buffer: Buffer, offset: number): DerElement {
  if (offset + 2 > buffer.length) {
    throw new Error('Truncated DER element');
  }
  const tag = buffer[offset];
  /* eslint-disable no-bitwise -- DER tag and length fields use bit masks. */
  if ((tag & 0x1f) === 0x1f) {
    throw new Error('Unsupported high-tag-number DER element');
  }
  const firstLength = buffer[offset + 1];
  let contentStart = offset + 2;
  let length = firstLength;
  if ((firstLength & 0x80) !== 0) {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes === 0 ||
      lengthBytes > 4 ||
      contentStart + lengthBytes > buffer.length
    ) {
      throw new Error('Invalid DER length');
    }
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = length * 256 + buffer[contentStart + index];
    }
    contentStart += lengthBytes;
  }
  /* eslint-enable no-bitwise */
  const end = contentStart + length;
  if (end > buffer.length) {
    throw new Error('DER element exceeds input bounds');
  }
  return { tag, start: offset, contentStart, end };
}

function resolveApksignerPath(): string | undefined {
  const sdkRoots = new Set(
    [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      join(homedir(), 'Library', 'Android', 'sdk'),
      join(homedir(), 'Android', 'Sdk'),
    ].filter((value): value is string => Boolean(value)),
  );
  const candidates: { path: string; version: string }[] = [];
  for (const root of sdkRoots) {
    const buildTools = join(root, 'build-tools');
    let versions: string[];
    try {
      versions = readdirSync(buildTools);
    } catch {
      continue;
    }
    for (const version of versions) {
      const path = join(buildTools, version, 'apksigner');
      try {
        accessSync(path, fsConstants.X_OK);
        candidates.push({ path, version });
      } catch {
        // This build-tools version does not provide an executable apksigner.
      }
    }
  }
  candidates.sort((left, right) =>
    compareVersions(right.version, left.version),
  );
  return candidates[0]?.path;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/u).map(Number);
  const rightParts = right.split(/[^0-9]+/u).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.localeCompare(right);
}

async function verifyWithApksigner(
  apksignerPath: string,
  apkPath: string,
  packageName: string,
  expectedSignerSha256: string,
  timeoutMs: number,
): Promise<void> {
  const result = await exec(
    apksignerPath,
    ['verify', '--print-certs', apkPath],
    { timeoutMs },
  );
  if (result.exitCode !== 0) {
    throw verificationFailed(packageName, 'apksigner verification failed', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      apksignerPath,
    });
  }
  const digests = [...result.stdout.matchAll(APK_SIGNER_DIGEST)].map((match) =>
    match[1].replace(/:/gu, '').toLowerCase(),
  );
  if (digests.length !== 1) {
    throw verificationFailed(
      packageName,
      'apksigner did not report exactly one signing certificate',
      { apksignerPath, signerCount: digests.length },
    );
  }
  assertSignerMatches(
    packageName,
    expectedSignerSha256,
    digests[0],
    'apksigner signing certificate',
  );
}

function assertSignerMatches(
  packageName: string,
  expected: string,
  actual: string,
  source: string,
): void {
  if (actual !== expected) {
    throw verificationFailed(
      packageName,
      `${source} does not match pinned signer`,
      {
        expectedSignerSha256: expected,
        actualSignerSha256: actual,
      },
    );
  }
}

function verificationFailed(
  packageName: string,
  reason: string,
  details?: Record<string, unknown>,
  cause?: unknown,
): SnapshotHelperError {
  return new SnapshotHelperError(
    'COMMAND_FAILED',
    `Could not verify Android snapshot helper signing certificate (${packageName}): ${reason}`,
    details,
    cause,
  );
}
