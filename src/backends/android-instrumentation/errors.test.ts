import { describe, it, expect } from 'vitest';

import {
  HelperIncompleteCaptureError,
  HelperNotInstalledError,
  SnapshotHelperError,
  UNTRUSTED_HELPER_REMEDY,
  UntrustedHelperError,
  isHelperIncompleteCaptureError,
  isHelperNotInstalledError,
  isUntrustedHelperError,
} from './errors.js';

describe('SnapshotHelperError', () => {
  it('carries a code and message and is an Error', () => {
    const error = new SnapshotHelperError('COMMAND_FAILED', 'adb died');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SnapshotHelperError);
    expect(error.code).toBe('COMMAND_FAILED');
    expect(error.message).toBe('adb died');
    expect(error.name).toBe('SnapshotHelperError');
  });

  it('preserves the cause', () => {
    const cause = new Error('root');
    const error = new SnapshotHelperError('INVALID_ARGS', 'bad', { cause });
    expect(error.cause).toBe(cause);
  });

  it('is not mistaken for a trust error', () => {
    const error = new SnapshotHelperError('ARTIFACT_INVALID', 'nope');
    expect(isUntrustedHelperError(error)).toBe(false);
  });
});

describe('UntrustedHelperError', () => {
  it('exposes the expected and actual signer digests', () => {
    const error = new UntrustedHelperError('signer mismatch', {
      expectedSignerSha256: 'aaaa',
      actualSignerSha256: 'bbbb',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UntrustedHelperError);
    expect(error.name).toBe('UntrustedHelperError');
    expect(error.expectedSignerSha256).toBe('aaaa');
    expect(error.actualSignerSha256).toBe('bbbb');
  });

  it('allows an unknown actual digest', () => {
    const error = new UntrustedHelperError('no signer found', {
      expectedSignerSha256: 'aaaa',
    });
    expect(error.actualSignerSha256).toBeUndefined();
  });

  it('is recognised by the type guard', () => {
    const error = new UntrustedHelperError('mismatch', {
      expectedSignerSha256: 'aaaa',
    });
    expect(isUntrustedHelperError(error)).toBe(true);
  });

  it('is distinguishable from a generic helper error when caught as unknown', () => {
    const errors: unknown[] = [
      new SnapshotHelperError('COMMAND_FAILED', 'generic'),
      new UntrustedHelperError('trust', { expectedSignerSha256: 'aaaa' }),
      new Error('plain'),
    ];
    const trustErrors = errors.filter(isUntrustedHelperError);
    expect(trustErrors).toHaveLength(1);
    expect(trustErrors[0]?.message).toBe('trust');
  });
});

describe('HelperNotInstalledError', () => {
  it('is a generic helper error, never a trust error', () => {
    const error = new HelperNotInstalledError('gone');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SnapshotHelperError);
    expect(error.name).toBe('HelperNotInstalledError');
    expect(error.code).toBe('COMMAND_FAILED');
    expect(isHelperNotInstalledError(error)).toBe(true);
    expect(isUntrustedHelperError(error)).toBe(false);
  });

  it('is not matched by the guard for other errors', () => {
    expect(
      isHelperNotInstalledError(
        new SnapshotHelperError('COMMAND_FAILED', 'adb died'),
      ),
    ).toBe(false);
    expect(
      isHelperNotInstalledError(
        new UntrustedHelperError('mismatch', { expectedSignerSha256: 'aaaa' }),
      ),
    ).toBe(false);
  });
});

describe('UNTRUSTED_HELPER_REMEDY', () => {
  it('names the uninstall command and the dump mode', () => {
    expect(UNTRUSTED_HELPER_REMEDY).toContain(
      'adb uninstall io.metamask.devicemcp.snapshothelper',
    );
    expect(UNTRUSTED_HELPER_REMEDY).toContain('DEVICE_MCP_ADB_SNAPSHOT=dump');
    expect(UNTRUSTED_HELPER_REMEDY).toContain("snapshotMode 'dump'");
  });
});

describe('HelperIncompleteCaptureError', () => {
  it('is a generic helper error, never a trust error', () => {
    const error = new HelperIncompleteCaptureError('did not stabilize');
    expect(error).toBeInstanceOf(SnapshotHelperError);
    expect(error.name).toBe('HelperIncompleteCaptureError');
    expect(isHelperIncompleteCaptureError(error)).toBe(true);
    expect(isUntrustedHelperError(error)).toBe(false);
    expect(isHelperNotInstalledError(error)).toBe(false);
    expect(isHelperIncompleteCaptureError(new Error('x'))).toBe(false);
  });
});
