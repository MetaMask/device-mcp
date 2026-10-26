/**
 * Recoverable helper errors may trigger retries or dump fallback.
 * {@link UntrustedHelperError} must propagate without either.
 *
 * Structure adapted from agent-device (MIT, Copyright (c) Callstack); the
 * `UntrustedHelperError` trust class and messaging are ours.
 */

/** Machine-readable code for a {@link SnapshotHelperError}. */
export type SnapshotHelperErrorCode =
  | 'COMMAND_FAILED'
  | 'INVALID_ARGS'
  | 'ARTIFACT_INVALID';

/**
 * A recoverable helper failure; fallback depends on the snapshot mode.
 */
export class SnapshotHelperError extends Error {
  public readonly code: SnapshotHelperErrorCode;

  /**
   * @param code - Machine-readable failure category.
   * @param message - Human-readable description.
   * @param options - Standard error options (e.g. `cause`).
   */
  public constructor(
    code: SnapshotHelperErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SnapshotHelperError';
    this.code = code;
    // Restore prototype chain for `instanceof` across the dual ESM/CJS build.
    Object.setPrototypeOf(this, SnapshotHelperError.prototype);
  }
}

/**
 * No installed APK path. Reinstall and verify before retrying.
 */
export class HelperNotInstalledError extends SnapshotHelperError {
  public constructor(message: string, options?: ErrorOptions) {
    super('COMMAND_FAILED', message, options);
    this.name = 'HelperNotInstalledError';
    Object.setPrototypeOf(this, HelperNotInstalledError.prototype);
  }
}

/**
 * Type guard for {@link HelperNotInstalledError}.
 *
 * @param error - The value to test.
 * @returns True when `error` is a {@link HelperNotInstalledError}.
 */
export function isHelperNotInstalledError(
  error: unknown,
): error is HelperNotInstalledError {
  return error instanceof HelperNotInstalledError;
}

/**
 * The foreground root did not stabilize, usually during a screen transition.
 * Retrying the capture may succeed.
 */
export class HelperIncompleteCaptureError extends SnapshotHelperError {
  public constructor(message: string, options?: ErrorOptions) {
    super('COMMAND_FAILED', message, options);
    this.name = 'HelperIncompleteCaptureError';
    Object.setPrototypeOf(this, HelperIncompleteCaptureError.prototype);
  }
}

/**
 * Type guard for {@link HelperIncompleteCaptureError}.
 *
 * @param error - The value to test.
 * @returns True when `error` is a {@link HelperIncompleteCaptureError}.
 */
export function isHelperIncompleteCaptureError(
  error: unknown,
): error is HelperIncompleteCaptureError {
  return error instanceof HelperIncompleteCaptureError;
}

export const UNTRUSTED_HELPER_REMEDY =
  'To fix: run `adb uninstall io.metamask.devicemcp.snapshothelper` to remove ' +
  'a helper signed with another key, so the bundled helper can be installed, ' +
  "or use snapshotMode 'dump' (DEVICE_MCP_ADB_SNAPSHOT=dump) to skip the helper.";

/**
 * A trust failure: the installed helper is not signed by our pinned key.
 *
 * This is a hard stop. It must propagate out of the snapshot flow — never be
 * converted to `null`, never be collected into a generic failure list, and
 * never trigger a `uiautomator dump` fallback.
 */
export class UntrustedHelperError extends Error {
  /** The signer SHA-256 we required. */
  public readonly expectedSignerSha256: string;

  /** The signer SHA-256 actually found on the device, if one was extracted. */
  public readonly actualSignerSha256?: string;

  /**
   * @param message - Human-readable description of the mismatch.
   * @param details - The expected and (optionally) observed signer digests.
   * @param details.expectedSignerSha256 - The pinned signer SHA-256.
   * @param details.actualSignerSha256 - The observed signer SHA-256, if known.
   * @param options - Standard error options (e.g. `cause`).
   */
  public constructor(
    message: string,
    details: {
      expectedSignerSha256: string;
      actualSignerSha256?: string;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'UntrustedHelperError';
    this.expectedSignerSha256 = details.expectedSignerSha256;
    this.actualSignerSha256 = details.actualSignerSha256;
    // Restore prototype chain for `instanceof` across the dual ESM/CJS build.
    Object.setPrototypeOf(this, UntrustedHelperError.prototype);
  }
}

/**
 * Type guard for the fail-closed trust error. The ADB backend uses this to
 * decide whether an instrumentation failure may fall back to `dump` (generic)
 * or must propagate (trust).
 *
 * @param error - The value to test.
 * @returns True when `error` is an {@link UntrustedHelperError}.
 */
export function isUntrustedHelperError(
  error: unknown,
): error is UntrustedHelperError {
  return error instanceof UntrustedHelperError;
}
