// Derived from agent-device (MIT, Copyright (c) 2026 Callstack)
// https://github.com/callstackincubator/agent-device/blob/336bf17af44e9be1810592d5dc42163771c3e8de/src/platforms/android/snapshot-helper-artifact.ts
// See ./vendor/NOTICE.md and ./vendor/LICENSE.MIT for attribution.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { SnapshotHelperError } from './errors.js';
import {
  ANDROID_SNAPSHOT_HELPER_NAME,
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
} from './types.js';
import type {
  AndroidSnapshotHelperArtifact,
  AndroidSnapshotHelperManifest,
} from './types.js';

const INSTALL_FLAG_ALLOWLIST = new Set(['-r', '-t', '-d', '-g']);
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export async function verifyAndroidSnapshotHelperArtifact(
  artifact: AndroidSnapshotHelperArtifact,
): Promise<void> {
  const actual = await sha256File(artifact.apkPath);
  if (actual !== artifact.manifest.sha256) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper APK checksum mismatch',
      {
        apkPath: artifact.apkPath,
        expectedSha256: artifact.manifest.sha256,
        actualSha256: actual,
      },
    );
  }
}

export function parseAndroidSnapshotHelperManifest(
  value: unknown,
): AndroidSnapshotHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SnapshotHelperError(
      'INVALID_ARGS',
      'Android snapshot helper manifest must be an object.',
    );
  }
  const record = value as Record<string, unknown>;
  return {
    name: readLiteral(record.name, 'name', ANDROID_SNAPSHOT_HELPER_NAME),
    version: readString(record.version, 'version'),
    releaseTag: readOptionalString(record.releaseTag, 'releaseTag'),
    assetName: readOptionalString(record.assetName, 'assetName'),
    apkUrl: readNullableString(record.apkUrl, 'apkUrl'),
    sha256: readSha256(record.sha256, 'sha256'),
    expectedSignerSha256: readSha256(
      record.expectedSignerSha256,
      'expectedSignerSha256',
    ),
    checksumName: readOptionalString(record.checksumName, 'checksumName'),
    packageName: readString(record.packageName, 'packageName'),
    versionCode: readNumber(record.versionCode, 'versionCode'),
    instrumentationRunner: readString(
      record.instrumentationRunner,
      'instrumentationRunner',
    ),
    minSdk: readNumber(record.minSdk, 'minSdk'),
    targetSdk:
      record.targetSdk === undefined
        ? undefined
        : readNumber(record.targetSdk, 'targetSdk'),
    outputFormat: readLiteral(
      record.outputFormat,
      'outputFormat',
      ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    ),
    statusProtocol: readLiteral(
      record.statusProtocol,
      'statusProtocol',
      ANDROID_SNAPSHOT_HELPER_PROTOCOL,
    ),
    installArgs: readInstallArgs(record.installArgs),
  };
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidField(field, 'a non-empty string');
  }
  return value;
}

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value, field);
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return readString(value, field);
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidField(field, 'an integer');
  }
  return value;
}

function readLiteral<Value extends string>(
  value: unknown,
  field: string,
  expected: Value,
): Value {
  if (value !== expected) {
    throw invalidField(field, `the literal "${expected}"`);
  }
  return expected;
}

function readSha256(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalidField(field, 'a hex string');
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_HEX.test(normalized)) {
    throw invalidField(field, '64 lowercase hex characters');
  }
  return normalized;
}

function readInstallArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidField('installArgs', 'a non-empty array');
  }
  const args = value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.includes('\0')) {
      throw invalidField(
        `installArgs[${index}]`,
        'a string without null bytes',
      );
    }
    return entry;
  });
  if (args[0] !== 'install') {
    throw invalidField('installArgs', 'to start with "install"');
  }
  for (const flag of args.slice(1)) {
    if (!INSTALL_FLAG_ALLOWLIST.has(flag)) {
      throw invalidField(
        'installArgs',
        'only the flags -r, -t, -d, -g after "install"',
      );
    }
  }
  return args;
}

function invalidField(field: string, expectation: string): SnapshotHelperError {
  return new SnapshotHelperError(
    'INVALID_ARGS',
    `Android snapshot helper manifest field "${field}" must be ${expectation}.`,
  );
}
