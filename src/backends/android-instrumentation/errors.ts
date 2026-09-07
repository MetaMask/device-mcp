/**
 * Error types for the Android snapshot-helper trust + install pipeline.
 *
 * Two failure classes are deliberately distinct because the ADB backend treats
 * them differently (see `adb-backend.ts`):
 *
 * - {@link SnapshotHelperError} — a *generic* failure (install failed, adb
 *   hiccup, malformed artifact). The `auto` snapshot strategy is allowed to fall
 *   back to `uiautomator dump` when one of these occurs.
 * - {@link UntrustedHelperError} — the installed helper's signing certificate
 *   does NOT match the pinned signer. This means a possibly-malicious app is
 *   squatting the helper's package name. The snapshot flow MUST fail closed:
 *   it is never swallowed and never triggers a dump fallback, because silently
 *   returning a dump snapshot would hide a compromised device from a wallet
 *   test harness.
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
 * A generic, recoverable snapshot-helper failure. Callers in `auto` mode may
 * fall back to `uiautomator dump` after catching one of these.
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
