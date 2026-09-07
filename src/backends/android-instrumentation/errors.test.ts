import { describe, it, expect } from 'vitest';

import {
  SnapshotHelperError,
  UntrustedHelperError,
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
