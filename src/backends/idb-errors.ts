/** Typed error codes for iOS (idb) transport failures. */
export type IdbErrorCode = 'IDB_HID_UNAVAILABLE' | 'IDB_COMPANION_UNAVAILABLE';

export type IdbFailure = {
  code: IdbErrorCode;
  /**
   * True when the failure proves the command was not delivered, so sending
   * it again cannot repeat an action. HID events sent on an invalidated
   * dtuhidd connection are discarded, and a companion that cannot be reached
   * received nothing.
   */
  notDelivered: boolean;
};

const HID_PATTERNS = [
  /dtuhidd .*(?:invalidated|interrupted|did not answer)/iu,
  /events? sent (?:on|to) it would be discarded/iu,
];

const COMPANION_NOT_REACHED = /Failed to connect to companion/iu;

const COMPANION_UNAVAILABLE = 'StatusCode.UNAVAILABLE';

const UNSAFE_VERDICT = /^retry: unsafe\b/mu;

/**
 * Classify an idb failure from its stderr (or an execStrict error message).
 *
 * @param text - The failure text.
 * @returns The failure kind, or undefined for any other error.
 */
export function classifyIdbFailure(text: string): IdbFailure | undefined {
  // An explicit companion verdict (idb --retry-verdict) always wins.
  const unsafe = UNSAFE_VERDICT.test(text);
  if (HID_PATTERNS.some((pattern) => pattern.test(text))) {
    return { code: 'IDB_HID_UNAVAILABLE', notDelivered: !unsafe };
  }
  if (COMPANION_NOT_REACHED.test(text)) {
    return { code: 'IDB_COMPANION_UNAVAILABLE', notDelivered: !unsafe };
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
