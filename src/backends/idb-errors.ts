/** Typed error codes for iOS (idb) transport failures. */
export type IdbErrorCode = 'IDB_HID_UNAVAILABLE' | 'IDB_COMPANION_UNAVAILABLE';

export type IdbFailure = {
  code: IdbErrorCode;
  /**
   * True when the failing event or request was refused before delivery.
   *
   * - HID: the companion refuses the event that hits an invalidated dtuhidd
   * connection, so that event was not delivered. An idb command can be a
   * stream of events (`ui text` sends one down/up pair per character,
   * `ui swipe` sends many touches). When the connection was already stale,
   * the first event fails and nothing landed; this is the observed failure,
   * and a resend through a fresh companion is safe. When the simulator dies
   * partway through a command, a leading part of it (some characters or
   * touches) may already have landed.
   * - Companion not reached: the request was never sent.
   */
  notDelivered: boolean;
};

// Thrown errors of the idb_companion HID transport (facebook/idb v1.7.1,
// FBSimulatorControl/HID/SimulatorHIDError.swift). Companion log lines (for
// example "was interrupted" or a single failed liveness probe) never reach
// idb stderr, so they are not matched.
const HID_PATTERNS = [
  // dtuhidConnectionInvalidated, thrown by SimulatorDTUHIDConnection.write():
  // "The dtuhidd connection (<name>) has been invalidated; events sent on it
  // would be discarded".
  /dtuhidd connection .*has been invalidated/iu,
  // The invalidated error above, and dtuhidUnresponsive, thrown by
  // SimulatorDTUHIDConnection.connect() before any event is written:
  // "dtuhidd did not answer a liveness probe in 5 attempts ... every HID event
  // sent to it would be discarded without error".
  /events? sent (?:on|to) it would be discarded/iu,
];

const COMPANION_NOT_REACHED = /Failed to connect to companion/iu;

const COMPANION_UNAVAILABLE = 'StatusCode.UNAVAILABLE';

/**
 * Classify an idb failure from its stderr (or an execStrict error message).
 *
 * @param text - The failure text.
 * @returns The failure kind, or undefined for any other error.
 */
export function classifyIdbFailure(text: string): IdbFailure | undefined {
  if (HID_PATTERNS.some((pattern) => pattern.test(text))) {
    return { code: 'IDB_HID_UNAVAILABLE', notDelivered: true };
  }
  if (COMPANION_NOT_REACHED.test(text)) {
    return { code: 'IDB_COMPANION_UNAVAILABLE', notDelivered: true };
  }
  if (text.includes(COMPANION_UNAVAILABLE)) {
    // The channel failed, but possibly after the request was sent.
    return { code: 'IDB_COMPANION_UNAVAILABLE', notDelivered: false };
  }
  return undefined;
}

const REMEDIATION: Record<IdbErrorCode, string> = {
  IDB_HID_UNAVAILABLE:
    'The simulator HID (touch/keyboard) connection is invalid even after a fresh private companion. ' +
    'The simulator was probably shut down or rebooted during the session. ' +
    'Recreate the session (mm cleanup, then mm launch; or dispose and recreate the backend). ' +
    'If it persists, reboot the simulator: xcrun simctl shutdown <udid> && xcrun simctl boot <udid>.',
  IDB_COMPANION_UNAVAILABLE:
    'The private idb_companion cannot be reached even after a restart. ' +
    'Check that the simulator is booted (xcrun simctl list devices booted) and that idb_companion is installed, ' +
    'then recreate the session.',
};

/** An idb transport failure that a reconnect and one retry did not fix. */
export class IdbUnavailableError extends Error {
  readonly code: IdbErrorCode;

  readonly remediation: string;

  readonly udid: string;

  constructor(
    code: IdbErrorCode,
    udid: string,
    detail: string,
    options?: { cause?: unknown; mayHaveRun?: boolean },
  ) {
    const lastLine =
      detail
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .pop() ?? '';
    const ran = options?.mayHaveRun
      ? ' The action may have run before the connection failed; check the screen before repeating it.'
      : '';
    super(
      `${code}: iOS simulator ${udid}: ${lastLine.slice(0, 300)}.${ran} ${REMEDIATION[code]}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'IdbUnavailableError';
    this.code = code;
    this.remediation = REMEDIATION[code];
    this.udid = udid;
  }
}
