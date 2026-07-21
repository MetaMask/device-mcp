/**
 * Standalone state module for Hermes CDP sessions.
 *
 * Holds the resolved Metro inspector proxy port, the expected app bundle ID,
 * and the pinned Hermes `logicalDeviceId`. This module is intentionally
 * INDEPENDENT of `DeviceBackend` — Hermes/Metro access is orthogonal to the
 * idb/adb/Appium UI automation backends, and it stores no live connection
 * (the MVP opens a fresh WebSocket per tool call).
 *
 * Resolution precedence for both port and appId is exactly:
 *   per-call param > environment variable > default.
 */

/**
 * Platform identifier used to pick the default app bundle ID.
 *
 * Kept structurally compatible with the backend's `Platform` type without
 * importing it, so this module stays decoupled from `DeviceBackend`.
 */
export type HermesPlatform = 'ios' | 'android';

/** Default MetaMask app bundle ID for iOS (`CFBundleIdentifier`). */
export const DEFAULT_IOS_APP_ID = 'io.metamask.MetaMask';

/** Default MetaMask app bundle ID for Android (`applicationId`). */
export const DEFAULT_ANDROID_APP_ID = 'io.metamask';

/** Default Metro inspector proxy port when none is configured. */
export const DEFAULT_METRO_PORT = 8081;

/**
 * Resolve the platform default app bundle ID.
 *
 * Defaults to the iOS id when the platform is unknown. Agents running against
 * Android should pass `appId` per call or set `HERMES_APP_ID` if they are not
 * using the default Android bundle ID.
 *
 * @param platform - The active platform, if known.
 * @returns The default app bundle ID for the platform.
 */
export function defaultAppIdForPlatform(platform?: HermesPlatform): string {
  return platform === 'android' ? DEFAULT_ANDROID_APP_ID : DEFAULT_IOS_APP_ID;
}

/**
 * Parse a Metro port from an environment variable value.
 *
 * @param value - The raw environment variable value (or undefined).
 * @returns The parsed integer port, or undefined when unset/invalid.
 */
function parseEnvPort(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Per-call overrides accepted by {@link HermesSession.resolve}.
 *
 * Any field left undefined falls back to the session default (which itself
 * falls back to the relevant environment variable, then the hardcoded default).
 */
export type HermesSessionResolveInput = {
  /** Override the Metro inspector proxy port for this call. */
  metroPort?: number;
  /** Override the expected app bundle ID for this call. */
  appId?: string;
  /**
   * The active platform, used to compute the default app bundle ID AT CALL
   * TIME when neither a per-call `appId` nor the `HERMES_APP_ID` env var is set.
   * This lets a session created before a device connects (when the platform is
   * not yet known) still resolve the correct Android default once the backend's
   * live platform becomes `'android'`.
   */
  platform?: HermesPlatform;
};

/**
 * The effective Hermes session parameters for a single tool call.
 */
export type HermesSessionResolved = {
  /** The resolved Metro inspector proxy port. */
  metroPort: number;
  /** The resolved expected app bundle ID. */
  appId: string;
  /** The pinned Hermes `logicalDeviceId`, if one has been set. */
  pinnedDeviceId: string | undefined;
};

/**
 * Options for constructing a {@link HermesSession}.
 */
export type HermesSessionOptions = {
  /** The active platform, used only to pick the default app bundle ID. */
  platform?: HermesPlatform;
  /**
   * Environment source. Defaults to `process.env`. Injectable for tests so
   * resolution precedence can be exercised without mutating the real env.
   */
  env?: NodeJS.ProcessEnv;
};

/**
 * Holds the Metro port, expected appId, and pinned Hermes deviceId for a
 * process-lifetime Hermes session.
 *
 * The stored port and appId are resolved once at construction time using
 * `param ?? env ?? default` precedence (with `param` being undefined at
 * construction — those are supplied per call to {@link resolve}). The pinned
 * deviceId starts unset and is assigned on the first successful identity probe.
 */
export class HermesSession {
  readonly #metroPort: number;

  readonly #expectedAppId: string;

  /**
   * Whether {@link #expectedAppId} came from an explicit source (the
   * `HERMES_APP_ID` env var) rather than the platform fallback. When true, the
   * stored appId is a deliberate override and {@link resolve} must not let a
   * per-call `platform` recompute it; when false, the stored value is only the
   * construction-time platform default and `resolve` may recompute it from the
   * live platform.
   */
  readonly #appIdFromEnv: boolean;

  #pinnedDeviceId: string | undefined;

  constructor(options: HermesSessionOptions = {}) {
    const env = options.env ?? process.env;

    this.#metroPort = parseEnvPort(env.HERMES_METRO_PORT) ?? DEFAULT_METRO_PORT;

    this.#appIdFromEnv = env.HERMES_APP_ID !== undefined;
    this.#expectedAppId =
      env.HERMES_APP_ID ?? defaultAppIdForPlatform(options.platform);

    this.#pinnedDeviceId = undefined;
  }

  /**
   * Returns the session-default Metro inspector proxy port.
   *
   * @returns The resolved Metro port (env `HERMES_METRO_PORT`, else 8081).
   */
  getMetroPort(): number {
    return this.#metroPort;
  }

  /**
   * Returns the session-default expected app bundle ID.
   *
   * @returns The resolved app bundle ID (env `HERMES_APP_ID`, else the
   * platform default).
   */
  getAppId(): string {
    return this.#expectedAppId;
  }

  /**
   * Returns the pinned Hermes `logicalDeviceId` for this session, if any.
   *
   * Set on the first successful identity probe via
   * {@link setPinnedHermesDeviceId}. Persists for the lifetime of this
   * instance.
   *
   * @returns The pinned `logicalDeviceId`, or undefined when no pin is set.
   */
  getPinnedHermesDeviceId(): string | undefined {
    return this.#pinnedDeviceId;
  }

  /**
   * Pin the Hermes `logicalDeviceId` for this session.
   *
   * Called after a successful identity probe on the first call. Subsequent
   * calls then enforce this pin to prevent target switching mid-session.
   *
   * @param id - The `logicalDeviceId` from Metro's
   * `reactNative.logicalDeviceId` field.
   */
  setPinnedHermesDeviceId(id: string): void {
    this.#pinnedDeviceId = id;
  }

  /**
   * Resolve the effective parameters for a single tool call by merging
   * per-call overrides over the stored session defaults.
   *
   * This is PURE with respect to stored state: it never mutates the stored
   * port, appId, or pin. Only {@link setPinnedHermesDeviceId} mutates the pin.
   *
   * Port precedence is `input.metroPort ?? this.getMetroPort()` (which itself
   * already encodes `env ?? default`), mirroring the reference driver's
   * `input.metroPort ?? driver.getMetroPort() ?? 8081`.
   *
   * AppId precedence is `input.appId ?? <HERMES_APP_ID env if set> ??
   * defaultAppIdForPlatform(input.platform) ?? <stored default>`. An explicitly
   * set `HERMES_APP_ID` always WINS over the per-call platform default (env is a
   * deliberate override): in that case the stored appId is returned unchanged.
   * Only when the stored appId is the construction-time platform fallback does
   * a per-call `platform` recompute it — without mutating stored state. When no
   * `platform` is passed this preserves the original iOS-default behavior.
   *
   * @param input - Optional per-call overrides for port, appId, and platform.
   * @returns The effective `{ metroPort, appId, pinnedDeviceId }`.
   */
  resolve(input: HermesSessionResolveInput = {}): HermesSessionResolved {
    return {
      metroPort: input.metroPort ?? this.#metroPort,
      appId: input.appId ?? this.#resolveAppId(input.platform),
      pinnedDeviceId: this.#pinnedDeviceId,
    };
  }

  /**
   * Compute the effective default appId for a call, honouring the
   * env-over-platform-default precedence documented on {@link resolve}.
   *
   * @param platform - The live platform passed for this call, if any.
   * @returns The stored env/explicit appId, or the platform default.
   */
  #resolveAppId(platform: HermesPlatform | undefined): string {
    if (this.#appIdFromEnv || platform === undefined) {
      return this.#expectedAppId;
    }
    return defaultAppIdForPlatform(platform);
  }
}

/**
 * Module-level lazily-created singleton instance.
 */
let sessionInstance: HermesSession | undefined;

/**
 * Returns the process-singleton {@link HermesSession}, creating it on first
 * access.
 *
 * @param options - Options applied only when the singleton is first created.
 * @returns The shared `HermesSession` instance.
 */
export function getHermesSession(
  options?: HermesSessionOptions,
): HermesSession {
  if (sessionInstance === undefined) {
    sessionInstance = new HermesSession(options);
  }
  return sessionInstance;
}

/**
 * Resets the process-singleton {@link HermesSession}.
 *
 * Intended for test isolation so each test can start from a clean session.
 */
export function resetHermesSession(): void {
  sessionInstance = undefined;
}
