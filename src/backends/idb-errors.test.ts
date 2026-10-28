import { describe, expect, it } from 'vitest';

import { classifyIdbFailure, IdbUnavailableError } from './idb-errors.js';

describe('classifyIdbFailure', () => {
  it.each([
    [
      'The dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; events sent on it would be discarded',
      'IDB_HID_UNAVAILABLE',
      true,
    ],
    [
      'dtuhidd connection (com.apple.coredevice.feature.remote.hid.digitizer) was interrupted',
      'IDB_HID_UNAVAILABLE',
      true,
    ],
    [
      'dtuhidd did not answer the liveness probe (attempt 3)',
      'IDB_HID_UNAVAILABLE',
      true,
    ],
    [
      "Failed to connect to companion at address DomainSocketAddress(path='/tmp/device-mcp-idb-a/companion.sock'): [Errno 2] No such file or directory",
      'IDB_COMPANION_UNAVAILABLE',
      true,
    ],
    [
      'grpclib.exceptions.GRPCError: (<Status.UNAVAILABLE: 14>) StatusCode.UNAVAILABLE',
      'IDB_COMPANION_UNAVAILABLE',
      false,
    ],
    [
      'The dtuhidd connection (x) has been invalidated\nretry: unsafe (outcome_unknown)',
      'IDB_HID_UNAVAILABLE',
      false,
    ],
  ])('classifies %s', (text, code, notDelivered) => {
    expect(classifyIdbFailure(text)).toStrictEqual({ code, notDelivered });
  });

  it.each(['Element not found', 'No such app', ''])(
    'leaves other failures unclassified: %s',
    (text) => {
      expect(classifyIdbFailure(text)).toBeUndefined();
    },
  );
});

describe('IdbUnavailableError', () => {
  it('carries a code, the device and a remediation', () => {
    const cause = new Error('raw');
    const error = new IdbUnavailableError(
      'IDB_HID_UNAVAILABLE',
      'UDID-1',
      'stderr: first\nThe dtuhidd connection has been invalidated\n',
      { cause },
    );
    expect(error.name).toBe('IdbUnavailableError');
    expect(error.code).toBe('IDB_HID_UNAVAILABLE');
    expect(error.udid).toBe('UDID-1');
    expect(error.cause).toBe(cause);
    expect(error.message).toMatch(
      /^IDB_HID_UNAVAILABLE: iOS simulator UDID-1: The dtuhidd connection has been invalidated\. /u,
    );
    expect(error.message).toContain(error.remediation);
    expect(error.message).not.toContain('may have run');
  });

  it('warns when the action may have run', () => {
    const error = new IdbUnavailableError(
      'IDB_COMPANION_UNAVAILABLE',
      'UDID-1',
      '',
      { mayHaveRun: true },
    );
    expect(error.message).toContain('may have run');
    expect(error.cause).toBeUndefined();
  });
});
