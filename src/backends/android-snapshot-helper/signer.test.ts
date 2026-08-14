import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeApkV1SignerSha256,
  resolveBundledAndroidSnapshotHelper,
} from './index.js';
import {
  resolveApksignerPath,
  verifyInstalledAndroidSnapshotHelperSigner,
} from './signer.js';
import type { AndroidAdbExecutor } from './types.js';

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

const CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDRjCCAi6gAwIBAgIJAL/QiPEkJtvDMA0GCSqGSIb3DQEBCwUAMFAxCzAJBgNV',
  'BAYTAlVTMRIwEAYDVQQKEwlDYWxsc3RhY2sxLTArBgNVBAMTJEFnZW50IERldmlj',
  'ZSBBbmRyb2lkIFNuYXBzaG90IEhlbHBlcjAgFw0yNjA0MjcwMTE5NTlaGA8yMDUz',
  'MDkxMjAxMTk1OVowUDELMAkGA1UEBhMCVVMxEjAQBgNVBAoTCUNhbGxzdGFjazEt',
  'MCsGA1UEAxMkQWdlbnQgRGV2aWNlIEFuZHJvaWQgU25hcHNob3QgSGVscGVyMIIB',
  'IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApCG3QKqk6uUOIumnF7gzXeWl',
  'hIG4hNC1jC4KZX18BOZNAjyX+uyZi603UbR+aUldvU1Y9qKzSctXwniar4v95Ksl',
  'cqyzHRZRSVwRjTHaZdtTfAqaMm7ydjMeIRBNKUVlR0M2qHWWFW5TtPhOeId0GF2v',
  'MIylRfXE0tfxh71cowNrnvahqDadUBuvka+mJz5urMXumlR9A561nfUY+NDhOR5f',
  'gpg0J8k8hkjFJDt42/X1LezhSUUawhxGJRZVnybv1yJ+8X0+61HlJ9nAsR/DsFCW',
  'C8rkWjCCV52hgQRHE4ZALxZeh66+4s5DwUenS8bfCGoFoJNu0/3tBtjrXpPmAQID',
  'AQABoyEwHzAdBgNVHQ4EFgQUV4hpu168/Sx0DxQVscyjKmu7PnIwDQYJKoZIhvcN',
  'AQELBQADggEBAFwMlmaa77WIHMmBf9bbZpA6VlE6PJ//zTm8U6EUNPJNCMU/cT5H',
  '9YmjqjtuaPJ8PouK+1CJu7EmB9zbchmthdjy+ywiwFMtw98OmfNib00o9GdablwY',
  'N/e2/UPYT41Inisw/PDcwpr+2bn1Lr9dqfzsP/65kIH6mn3qO/qi5HNK1qD+Bq/R',
  'dGcAFfxSPdKZ8u+3DquNBBYcyjxYLkJgRZmqB9cBTBMLrsP7dV1NtsiSyuBcMYC3',
  '2VtTZ6OttMlJUNvKKyjHByJaGM5AfbQYXchcb12zSP6G7Hv20SjiMJbx2OnkZdZM',
  '1A5ma9vrn3yomTdBoXdIlGSL3s4pTw3i6vI=',
  '-----END CERTIFICATE-----',
].join('\n');

const OTHER_CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIDUTCCAjmgAwIBAgIUf2GdeuwLqHYb2rjbgKrDlRB3O48wDQYJKoZIhvcNAQEL',
  'BQAwODEaMBgGA1UEAwwRT3RoZXIgVGVzdCBTaWduZXIxDTALBgNVBAoMBFRlc3Qx',
  'CzAJBgNVBAYTAlVTMB4XDTI2MDgxNDE1NTExMloXDTM2MDgxMTE1NTExMlowODEa',
  'MBgGA1UEAwwRT3RoZXIgVGVzdCBTaWduZXIxDTALBgNVBAoMBFRlc3QxCzAJBgNV',
  'BAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2PzRaW1V/i/v',
  'dh4IE+bO7r/rQeutt5BL3oZlti4MmDxy9mtdCTVfauEmB521FYrnQ9AybMMHy5PW',
  'qhowm2e+vQ8CrOTq4Xf9sOIolqLYihbua/9R2Nvqu+lfn24cWpa6WwLNw7MAoA+M',
  'xA6p55UnxH+RWsUniOQXTp7CLbG0N18I/BNW0Su4Hd1mSyrC+FqXNV1NG+peL1DN',
  'kcAXvNzvPX8NN1I7m1CArQ0+VFM3/SQyhqDZZxTjKxqjrFoC7yRDVIcWNqi9Zj+w',
  'oP3xGde22O5wcoss4xdkbwedBYD8mdQvCuKl8eqpoO8ms5CgrA6EZY1heFBP6+Qi',
  'Khw9JRrYUQIDAQABo1MwUTAdBgNVHQ4EFgQUuiPHY6355trtGEkgOf6uOsI19Wow',
  'HwYDVR0jBBgwFoAUuiPHY6355trtGEkgOf6uOsI19WowDwYDVR0TAQH/BAUwAwEB',
  '/zANBgkqhkiG9w0BAQsFAAOCAQEAT6J5Dv2eLX0dY1c4J8n57FHv61Hg4HoO+s+c',
  'gpUFp06D5lH7wTmclIwMdU1G3xTw3XoWjCTg1t+xiuILIYDNQTnU5IZL5wamxmXO',
  'oYrszXmFAhv+3EM0HbqHDvGblB5JU5ubRI8LzPbvwYFKx/FMHcKZ4HDhw7Fx9NMi',
  '0Qt3jJ/FtmTp5vNPTITVC96iMNEICR+fR+aVqqLKzV34fUH/Tgci1WaNwRxTZTpn',
  'YQIpQkeU4/2R79e8DB9bcpKMem38iGCHkhdaCeFP24wU9po4eW27Oe7/0guetA18',
  'AAcPs++SKbPl7Uac1qN1sAP6xDhdFCO5ukH+zH1En5LutclD+A==',
  '-----END CERTIFICATE-----',
].join('\n');

// Build Tools 36 labels the leaf `Signer #1`; Build Tools 37 labels it
// `V3.0 Signer:`. Only the labels differ — the PEM block is identical — so the
// parser must key off the PEM, not the label.
const APKSIGNER_STDOUT_BT36 = `Signer #1 certificate DN: CN=Agent Device Android Snapshot Helper\nSigner #1 certificate SHA-256 digest: f5dc3a7bf83a1b17312c222cd89a2f781230f34a7a407e6033fa28adf0b3cf48\n${CERTIFICATE_PEM}\n`;
const APKSIGNER_STDOUT_BT37 = `V3.0 Signer: certificate DN: CN=Agent Device Android Snapshot Helper\nV3.0 Signer: certificate SHA-256 digest: f5dc3a7bf83a1b17312c222cd89a2f781230f34a7a407e6033fa28adf0b3cf48\n${CERTIFICATE_PEM}\n`;

describe('verifyInstalledAndroidSnapshotHelperSigner apksigner cross-check', () => {
  const artifact = resolveBundledAndroidSnapshotHelper();

  function bundledApkAdb(): AndroidAdbExecutor {
    return async (args) => {
      if (args[0] === 'shell' && args.includes('path')) {
        return {
          stdout: 'package:/data/app/base.apk',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'pull') {
        copyFileSync(artifact.apkPath, args[2]);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
  }

  function apksignerStub(stdout: string, exitCode = 0) {
    return {
      resolveApksignerPath: () => '/sdk/build-tools/x/apksigner',
      exec: vi.fn(async () => ({ stdout, stderr: '', exitCode })),
    };
  }

  it.each([
    ['Build Tools 36 output', APKSIGNER_STDOUT_BT36],
    ['Build Tools 37 output', APKSIGNER_STDOUT_BT37],
  ])('accepts a matching signer from %s', async (_label, stdout) => {
    const apksigner = apksignerStub(stdout);

    expect(
      await verifyInstalledAndroidSnapshotHelperSigner({
        adb: bundledApkAdb(),
        packageName: artifact.manifest.packageName,
        expectedSignerSha256: artifact.manifest.expectedSignerSha256,
        minSdk: artifact.manifest.minSdk,
        timeoutMs: 15_000,
        apksigner,
      }),
    ).toBeUndefined();

    expect(apksigner.exec).toHaveBeenCalledWith(
      '/sdk/build-tools/x/apksigner',
      [
        'verify',
        '--min-sdk-version',
        String(artifact.manifest.minSdk),
        '--print-certs-pem',
        expect.any(String),
      ],
      { timeoutMs: 15_000 },
    );
  });

  it('rejects when apksigner reports a certificate other than the pin', async () => {
    await expect(
      verifyInstalledAndroidSnapshotHelperSigner({
        adb: bundledApkAdb(),
        packageName: artifact.manifest.packageName,
        expectedSignerSha256: artifact.manifest.expectedSignerSha256,
        minSdk: artifact.manifest.minSdk,
        timeoutMs: 15_000,
        apksigner: apksignerStub(`${OTHER_CERTIFICATE_PEM}\n`),
      }),
    ).rejects.toThrow(/apksigner signing certificate does not match pinned/u);
  });

  it('rejects when apksigner reports multiple distinct certificates', async () => {
    await expect(
      verifyInstalledAndroidSnapshotHelperSigner({
        adb: bundledApkAdb(),
        packageName: artifact.manifest.packageName,
        expectedSignerSha256: artifact.manifest.expectedSignerSha256,
        minSdk: artifact.manifest.minSdk,
        timeoutMs: 15_000,
        apksigner: apksignerStub(
          `${CERTIFICATE_PEM}\n${OTHER_CERTIFICATE_PEM}\n`,
        ),
      }),
    ).rejects.toThrow(/did not report exactly one signing certificate/u);
  });

  it('rejects when apksigner exits non-zero', async () => {
    await expect(
      verifyInstalledAndroidSnapshotHelperSigner({
        adb: bundledApkAdb(),
        packageName: artifact.manifest.packageName,
        expectedSignerSha256: artifact.manifest.expectedSignerSha256,
        minSdk: artifact.manifest.minSdk,
        timeoutMs: 15_000,
        apksigner: apksignerStub('DOES NOT VERIFY', 1),
      }),
    ).rejects.toThrow(/apksigner verification failed/u);
  });

  it('passes the pin check without apksigner when none is installed', async () => {
    expect(
      await verifyInstalledAndroidSnapshotHelperSigner({
        adb: bundledApkAdb(),
        packageName: artifact.manifest.packageName,
        expectedSignerSha256: artifact.manifest.expectedSignerSha256,
        minSdk: artifact.manifest.minSdk,
        timeoutMs: 15_000,
        apksigner: {
          resolveApksignerPath: () => undefined,
          exec: vi.fn(),
        },
      }),
    ).toBeUndefined();
  });
});

describe('resolveApksignerPath', () => {
  let sdkRoot: string;

  beforeEach(() => {
    sdkRoot = mkdtempSync(join(tmpdir(), 'device-mcp-sdk-'));
    vi.stubEnv('ANDROID_HOME', sdkRoot);
    vi.stubEnv('ANDROID_SDK_ROOT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(sdkRoot, { recursive: true, force: true });
  });

  function installFakeApksigner(version: string, executable: boolean): string {
    const dir = join(sdkRoot, 'build-tools', version);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'apksigner');
    writeFileSync(path, '');
    chmodSync(path, executable ? 0o755 : 0o644);
    return path;
  }

  it('selects the newest build-tools with an executable apksigner', () => {
    installFakeApksigner('30.0.3', true);
    const newest = installFakeApksigner('99.1.0', true);
    installFakeApksigner('99.0.9', true);

    expect(resolveApksignerPath()).toBe(newest);
  });

  it('ignores build-tools whose apksigner is not executable', () => {
    installFakeApksigner('99.9.9', false);
    const executable = installFakeApksigner('98.0.0', true);

    expect(resolveApksignerPath()).toBe(executable);
  });
});
