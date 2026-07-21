/**
 * Pure Hermes Chrome DevTools Protocol (CDP) core for `@metamask/device-mcp`.
 *
 * Ported from `@metamask/client-mcp-core`'s `src/tools/hermes-cdp.ts`, decoupled
 * from that repo's `ToolContext`/`ErrorCodes`/`createToolError|Success`. Every
 * function here takes EXPLICIT parameters (port, appId, pin) and returns a
 * discriminated {@link HermesCdpResult} so this module is MCP-free and
 * unit-testable. The tools layer is responsible for resolving session state and
 * for PERSISTING the device pin — this file never imports `HermesSession`.
 *
 * Mechanism: the React Native Hermes runtime connects out to Metro's inspector
 * proxy; Metro exposes debuggable targets over `http://localhost:<metroPort>/json`
 * and a per-target `webSocketDebuggerUrl`. We speak real CDP over that WebSocket
 * using the GLOBAL `WebSocket` (no library) and the global `fetch` for discovery.
 *
 * Five fail-closed safety checks are preserved VERBATIM from the reference:
 *   1. Strict `appId` match (`===`, no substring, no `targets[0]` fallback).
 *   2. `HermesInternal.getRuntimeProperties()` identity probe before the user method.
 *   3. Device pin on `reactNative.logicalDeviceId` (set on first success).
 *   4. Multi-device fail-closed (missing or >1 distinct `logicalDeviceId`).
 *   5. WebSocket URL validation (protocol/hostname/port).
 */

/**
 * Reported capability flags on a Metro Hermes target.
 */
type HermesCapabilities = {
  /** Whether the target supports native page reloads (newer RN registrations). */
  nativePageReloads?: boolean;
  /** Whether the target supports native source-code fetching. */
  nativeSourceCodeFetching?: boolean;
  /** Whether the target supports multiple concurrent debuggers. */
  supportsMultipleDebuggers?: boolean;
};

/**
 * React Native-specific metadata attached to a Metro Hermes target.
 */
type HermesReactNative = {
  /** Stable logical device identifier used for session pinning. */
  logicalDeviceId?: string;
  /** Reported capability flags for this target. */
  capabilities?: HermesCapabilities;
};

/**
 * A debuggable Hermes target as reported by Metro's `/json` (or `/json/list`)
 * discovery endpoint. Shape matches the reference implementation exactly.
 */
export type HermesTarget = {
  /** Metro's per-target identifier. */
  id?: string;
  /** Human-readable target title (used to filter the legacy synthetic page). */
  title?: string;
  /** Human-readable target description. */
  description?: string;
  /** The app bundle identifier this target belongs to (strict-matched). */
  appId?: string;
  /** The `ws://` URL used to speak CDP with this target. */
  webSocketDebuggerUrl?: string;
  /** React Native-specific metadata (logical device id + capabilities). */
  reactNative?: HermesReactNative;
};

/**
 * Discriminated result of a Hermes CDP operation.
 *
 * On success `result` carries the raw CDP `result` payload. On failure `code`
 * is a STABLE string error code (see the `HERMES_*` constants) and `message`
 * is a human-readable diagnostic preserving the reference's wording.
 */
export type HermesCdpResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/**
 * Parameters for {@link runHermesCdp}.
 */
export type RunHermesCdpInput = {
  /** The CDP method to invoke (e.g. `Runtime.evaluate`). */
  method: string;
  /** Optional CDP method parameters. */
  params?: Record<string, unknown>;
  /** Per-call timeout in milliseconds for discovery and each CDP round-trip. */
  timeoutMs: number;
  /** The resolved Metro inspector proxy port. */
  metroPort: number;
  /** The expected app bundle identifier (strict-matched against targets). */
  appId: string;
  /** The pinned `logicalDeviceId` for this session, if one has been set. */
  pinnedDeviceId?: string;
  /**
   * Callback invoked with the resolved `logicalDeviceId` on the FIRST
   * successful identity probe so the caller can persist the pin. This file
   * stays pure: it never imports or mutates session state itself.
   */
  onPin?: (logicalDeviceId: string) => void;
};

type CdpSuccessResponse = {
  id: number;
  result?: unknown;
};

type CdpErrorResponse = {
  id: number;
  error: {
    message?: string;
    code?: number;
    data?: unknown;
  };
};

type TargetSelection =
  | { ok: true; target: HermesTarget }
  | { ok: false; code: string; message: string };

type ProbeResult = { ok: true } | { ok: false; code: string; message: string };

/**
 * No Hermes debug target matched the expected appId (after synthetic-title and
 * pin filtering). Often means Metro is up but the app is not registered.
 */
export const HERMES_TARGET_NOT_FOUND = 'HERMES_TARGET_NOT_FOUND';

/**
 * A target was found but could not be verified as the expected Hermes runtime
 * (identity probe failed, missing `logicalDeviceId`, or non-JSON probe payload).
 */
export const HERMES_NOT_VERIFIED = 'HERMES_NOT_VERIFIED';

/**
 * Multiple distinct logical devices are registered without a session pin (or a
 * candidate is missing its `logicalDeviceId`); routing would be a guess, so we
 * fail closed.
 */
export const HERMES_MULTIPLE_DEVICES = 'HERMES_MULTIPLE_DEVICES';

/**
 * The resolved target's `logicalDeviceId` does not match the session pin.
 */
export const HERMES_DEVICE_PIN_MISMATCH = 'HERMES_DEVICE_PIN_MISMATCH';

/**
 * The requested CDP method is in the destructive blocked set.
 */
export const HERMES_BLOCKED_METHOD = 'HERMES_BLOCKED_METHOD';

/**
 * The target's `webSocketDebuggerUrl` failed protocol/hostname/port validation.
 */
export const HERMES_INVALID_WS_URL = 'HERMES_INVALID_WS_URL';

/**
 * The underlying connection (discovery fetch or WebSocket) failed.
 */
export const HERMES_CONNECTION_FAILED = 'HERMES_CONNECTION_FAILED';

/**
 * A discovery, socket-open, or CDP round-trip exceeded the configured timeout.
 */
export const HERMES_TIMEOUT = 'HERMES_TIMEOUT';

/**
 * The user's CDP method returned a CDP-level error.
 */
export const HERMES_CDP_FAILED = 'HERMES_CDP_FAILED';

/**
 * The global `WebSocket` constructor is unavailable in this Node runtime.
 */
export const HERMES_WEBSOCKET_UNAVAILABLE = 'HERMES_WEBSOCKET_UNAVAILABLE';

/**
 * CDP methods blocked for safety. Ported VERBATIM from the reference — do not
 * weaken.
 */
const HERMES_BLOCKED_METHODS = new Set([
  'Runtime.terminateExecution',
  'Inspector.detached',
]);

const DISCOVERY_PATHS = ['/json', '/json/list'];
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Title of the synthetic legacy "Improved Chrome Reloads" page that Metro
 * registers alongside the real Hermes target. Filtered out during selection.
 * Ported VERBATIM from the reference.
 */
export const LEGACY_SYNTHETIC_TITLE =
  'React Native Experimental (Improved Chrome Reloads)';

/**
 * JavaScript expression evaluated against a candidate target BEFORE the user's
 * method, to verify it is a genuine Hermes runtime. Copied VERBATIM from the
 * reference — do not alter the verification semantics.
 */
export const IDENTITY_PROBE_EXPR = `(function () {
  try {
    var hi = typeof HermesInternal !== 'undefined' ? HermesInternal : null;
    var p =
      hi && typeof hi.getRuntimeProperties === 'function'
        ? hi.getRuntimeProperties()
        : null;
    return JSON.stringify({
      isHermes: !!hi,
      ossVersion: p ? p['OSS Release Version'] : null,
      debuggerEnabled: p ? p['Debugger Enabled'] : null,
    });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})();`;

/**
 * Orchestrates a single verified Hermes CDP command end to end.
 *
 * Resolves a target from Metro discovery, enforces all five fail-closed safety
 * checks, runs the identity probe, persists the device pin via `onPin` on first
 * success, sends the user's method, and returns the raw CDP `result`. The caller
 * supplies the resolved port/appId/pin and persists the pin — this function is
 * pure with respect to session state.
 *
 * @param input - Method, params, timeout, resolved port/appId/pin, and the pin
 * persistence callback. See {@link RunHermesCdpInput}.
 * @returns A discriminated {@link HermesCdpResult}.
 */
export async function runHermesCdp(
  input: RunHermesCdpInput,
): Promise<HermesCdpResult> {
  if (HERMES_BLOCKED_METHODS.has(input.method)) {
    return {
      ok: false,
      code: HERMES_BLOCKED_METHOD,
      message:
        `CDP method "${input.method}" is blocked for safety. ` +
        `Blocked methods: ${[...HERMES_BLOCKED_METHODS].join(', ')}`,
    };
  }

  if (typeof WebSocket !== 'function') {
    return {
      ok: false,
      code: HERMES_WEBSOCKET_UNAVAILABLE,
      message:
        'Global WebSocket is unavailable. On Node 20 launch device-mcp with ' +
        'NODE_OPTIONS="--experimental-websocket" (or use Node 22+).',
    };
  }

  try {
    const targets = await fetchDiscoveryTargets(
      input.metroPort,
      input.timeoutMs,
    );
    const selection = selectHermesTarget(
      targets,
      input.appId,
      input.pinnedDeviceId,
    );
    if (!selection.ok) {
      return { ok: false, code: selection.code, message: selection.message };
    }

    const validation = validateWebSocketUrl(
      selection.target.webSocketDebuggerUrl,
      input.metroPort,
    );
    if (!validation.ok) {
      return {
        ok: false,
        code: HERMES_INVALID_WS_URL,
        message: validation.message,
      };
    }

    return await executeVerifiedCdpCommand(
      selection.target,
      input,
      input.pinnedDeviceId,
      input.onPin,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: HERMES_CONNECTION_FAILED,
      message: `Hermes CDP connection failed: ${message}`,
    };
  }
}

/**
 * Fetches debuggable Hermes targets from Metro, trying `/json` then falling
 * back to `/json/list`. Each attempt is bounded by an `AbortController`
 * timeout. The payload must be an array; non-object entries are filtered out.
 *
 * @param metroPort - The Metro inspector proxy port.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns The discovered targets (objects only).
 * @throws The last error encountered if all discovery paths fail.
 */
export async function fetchDiscoveryTargets(
  metroPort: number,
  timeoutMs: number,
): Promise<HermesTarget[]> {
  let lastError: unknown;

  for (const path of DISCOVERY_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://localhost:${metroPort}${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Metro ${path} returned HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`Metro ${path} returned a non-array response`);
      }

      return payload.filter(isHermesTarget);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Narrows an unknown discovery entry to a {@link HermesTarget} (object guard).
 *
 * @param value - A raw entry from the Metro discovery payload.
 * @returns True when `value` is a non-null object.
 */
function isHermesTarget(value: unknown): value is HermesTarget {
  return typeof value === 'object' && value !== null;
}

/**
 * Selects the single safe Hermes target for the expected app, applying the
 * fail-closed selection algorithm VERBATIM from the reference:
 *
 * `webSocketDebuggerUrl` present → drop the synthetic legacy title → strict
 * `appId` match (`===`) → pin filter → ambiguity check ({@link hasAmbiguousTarget})
 * → `nativePageReloads` tiebreak → last-in-array.
 *
 * @param targets - All discovered targets.
 * @param expectedAppId - The strict app bundle identifier to match.
 * @param pinnedDeviceId - The session pin, if set, used to filter candidates.
 * @returns The selected target or a classified failure.
 */
export function selectHermesTarget(
  targets: HermesTarget[],
  expectedAppId: string,
  pinnedDeviceId: string | undefined,
): TargetSelection {
  const seenAppIds = [...new Set(targets.map((target) => target.appId))].filter(
    (appId): appId is string => typeof appId === 'string',
  );

  let candidates = targets
    .filter((target) => Boolean(target.webSocketDebuggerUrl))
    .filter((target) => target.title !== LEGACY_SYNTHETIC_TITLE)
    .filter((target) => target.appId === expectedAppId);

  if (pinnedDeviceId) {
    candidates = candidates.filter(
      (target) => target.reactNative?.logicalDeviceId === pinnedDeviceId,
    );
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      code: HERMES_TARGET_NOT_FOUND,
      message: `No Hermes debug target found for appId ${expectedAppId}. Saw appIds: ${JSON.stringify(
        seenAppIds,
      )}`,
    };
  }

  if (hasAmbiguousTarget(candidates)) {
    return {
      ok: false,
      code: HERMES_MULTIPLE_DEVICES,
      message: `Ambiguous Hermes target after pin filtering. Candidates: ${candidates
        .map(
          (target) =>
            `${target.id ?? '<unknown>'} (device=${
              target.reactNative?.logicalDeviceId ?? '<missing>'
            })`,
        )
        .join(', ')}`,
    };
  }

  // Same-device tiebreak: prefer pages with nativePageReloads (newer RN page
  // registrations) over stale entries left behind after in-app reloads.
  const nativeReloadTargets = candidates.filter(
    (target) => target.reactNative?.capabilities?.nativePageReloads === true,
  );
  if (nativeReloadTargets.length > 0) {
    candidates = nativeReloadTargets;
  }

  return { ok: true, target: candidates[candidates.length - 1] };
}

/**
 * Determines whether a multi-candidate target list is too ambiguous to choose
 * from safely. Returns true when:
 * - any candidate is missing a `reactNative.logicalDeviceId` (we can't route safely), or
 * - candidates resolve to more than one distinct `logicalDeviceId` (multi-device
 *   without a session pin — picking any one would silently bind the wrong device).
 *
 * Returns false when all candidates share the same logical device ID. In that
 * case the caller falls through to the "last-in-array" tiebreak, matching the
 * React Native convention that the most recent page registration wins (e.g.,
 * stale + fresh page after an in-app reload).
 *
 * @param candidates - Targets remaining after appId/pin/capability filtering.
 * @returns True when the caller must fail closed; false when tiebreak is safe.
 */
export function hasAmbiguousTarget(candidates: HermesTarget[]): boolean {
  if (candidates.length <= 1) {
    return false;
  }
  const deviceIds = candidates.map(
    (target) => target.reactNative?.logicalDeviceId,
  );
  // Any candidate missing a logicalDeviceId → can't safely route.
  if (deviceIds.some((id) => !id)) {
    return true;
  }
  // Multiple distinct device IDs → multi-device without pin.
  return new Set(deviceIds).size > 1;
}

/**
 * Validates a target's `webSocketDebuggerUrl` before connecting. The protocol
 * must be `ws:`, the hostname must be loopback (`localhost`, `127.0.0.1`, `::1`,
 * or `[::1]`), and the port must equal the resolved Metro port. Ported VERBATIM
 * from the reference.
 *
 * @param rawUrl - The candidate `webSocketDebuggerUrl`.
 * @param expectedPort - The resolved Metro port the URL must point at.
 * @returns `{ ok: true }` when valid, otherwise a failure with a message.
 */
export function validateWebSocketUrl(
  rawUrl: string | undefined,
  expectedPort: number,
): { ok: true } | { ok: false; message: string } {
  if (!rawUrl) {
    return { ok: false, message: 'webSocketDebuggerUrl is missing' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      message: `webSocketDebuggerUrl is not a valid URL: ${rawUrl}`,
    };
  }

  if (parsed.protocol !== 'ws:') {
    return { ok: false, message: `Unexpected protocol '${parsed.protocol}'` };
  }
  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return { ok: false, message: `Unexpected hostname '${parsed.hostname}'` };
  }
  if (Number(parsed.port) !== expectedPort) {
    return {
      ok: false,
      message: `Port mismatch: target=${parsed.port} expected=${expectedPort}`,
    };
  }

  return { ok: true };
}

/**
 * Opens the target WebSocket, runs the identity probe, enforces the device pin
 * (persisting it via `onPin` on first success, failing closed on mismatch),
 * sends the user's method, matches the response by `id`, and always closes the
 * socket in a `finally`. Ported faithfully from the reference.
 *
 * @param target - The validated, selected target.
 * @param input - The original {@link RunHermesCdpInput} (method/params/timeout).
 * @param pinnedDeviceId - The session pin, if set.
 * @param onPin - Callback to persist the resolved pin on first success.
 * @returns A discriminated {@link HermesCdpResult}.
 */
export async function executeVerifiedCdpCommand(
  target: HermesTarget,
  input: RunHermesCdpInput,
  pinnedDeviceId: string | undefined,
  onPin: ((logicalDeviceId: string) => void) | undefined,
): Promise<HermesCdpResult> {
  if (!target.webSocketDebuggerUrl) {
    return {
      ok: false,
      code: HERMES_INVALID_WS_URL,
      message: 'Target is missing webSocketDebuggerUrl',
    };
  }
  if (typeof WebSocket !== 'function') {
    return {
      ok: false,
      code: HERMES_WEBSOCKET_UNAVAILABLE,
      message:
        'Global WebSocket is unavailable. On Node 20 launch device-mcp with ' +
        'NODE_OPTIONS="--experimental-websocket" (or use Node 22+).',
    };
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;

  try {
    await waitForSocketOpen(socket, input.timeoutMs);

    const probe = await runIdentityProbe(socket, input.timeoutMs, nextId);
    nextId += 1;
    if (!probe.ok) {
      return { ok: false, code: probe.code, message: probe.message };
    }

    const targetDeviceId = target.reactNative?.logicalDeviceId;
    if (!targetDeviceId) {
      return {
        ok: false,
        code: HERMES_NOT_VERIFIED,
        message: 'Target is missing reactNative.logicalDeviceId',
      };
    }
    if (!pinnedDeviceId) {
      onPin?.(targetDeviceId);
    } else if (pinnedDeviceId !== targetDeviceId) {
      return {
        ok: false,
        code: HERMES_DEVICE_PIN_MISMATCH,
        message: `Hermes target device ${targetDeviceId} does not match session pin ${pinnedDeviceId}`,
      };
    }

    const response = await sendUserMethod(socket, input, nextId);
    nextId += 1;
    if (isCdpErrorResponse(response)) {
      return {
        ok: false,
        code: HERMES_CDP_FAILED,
        message: `Hermes CDP "${input.method}" failed: ${formatCdpError(
          response,
        )}`,
      };
    }

    return { ok: true, result: response.result };
  } finally {
    closeSocket(socket);
  }
}

/**
 * Runs the {@link IDENTITY_PROBE_EXPR} against an open socket and verifies the
 * response confirms a Hermes runtime. Distinguishes timeout from connection
 * failure and unverified payloads.
 *
 * @param socket - The open target WebSocket.
 * @param timeoutMs - Round-trip timeout in milliseconds.
 * @param id - The CDP message id to use for this probe.
 * @returns A {@link ProbeResult}.
 */
async function runIdentityProbe(
  socket: WebSocket,
  timeoutMs: number,
  id: number,
): Promise<ProbeResult> {
  socket.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: IDENTITY_PROBE_EXPR, returnByValue: true },
    }),
  );

  let response: CdpSuccessResponse | CdpErrorResponse;
  try {
    response = await waitForCdpResponse(socket, id, timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timed out')) {
      return {
        ok: false,
        code: HERMES_TIMEOUT,
        message: `Identity probe timed out after ${timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      code: HERMES_CONNECTION_FAILED,
      message: `Hermes CDP connection failed: ${message}`,
    };
  }

  if (isCdpErrorResponse(response)) {
    return {
      ok: false,
      code: HERMES_NOT_VERIFIED,
      message: `Identity probe failed: ${formatCdpError(response)}`,
    };
  }

  const remoteResult = getProbeRemoteResult(response);
  if (remoteResult.subtype === 'error') {
    return {
      ok: false,
      code: HERMES_NOT_VERIFIED,
      message: 'Identity probe evaluation returned an error subtype',
    };
  }
  if (remoteResult.value === undefined || remoteResult.value === null) {
    return {
      ok: false,
      code: HERMES_NOT_VERIFIED,
      message: 'Identity probe response missing result.value',
    };
  }

  const raw =
    typeof remoteResult.value === 'string'
      ? remoteResult.value
      : JSON.stringify(remoteResult.value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      code: HERMES_NOT_VERIFIED,
      message: `Identity probe returned non-JSON: ${raw}`,
    };
  }

  if (!isHermesProbePayload(parsed)) {
    return {
      ok: false,
      code: HERMES_NOT_VERIFIED,
      message: `Identity probe did not verify Hermes runtime: ${raw}`,
    };
  }

  return { ok: true };
}

/**
 * Safely extracts the nested CDP `result.result` (the remote object) from a
 * `Runtime.evaluate` success response.
 *
 * @param response - A CDP success response.
 * @returns The remote object's `subtype`/`value`, or an empty object.
 */
function getProbeRemoteResult(response: CdpSuccessResponse): {
  subtype?: unknown;
  value?: unknown;
} {
  if (typeof response.result !== 'object' || response.result === null) {
    return {};
  }
  const outer = response.result as Record<string, unknown>;
  if (typeof outer.result !== 'object' || outer.result === null) {
    return {};
  }
  return outer.result;
}

/**
 * Narrows a parsed probe payload to one confirming a Hermes runtime.
 *
 * @param value - The parsed probe JSON payload.
 * @returns True when `isHermes === true`.
 */
function isHermesProbePayload(value: unknown): value is { isHermes: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).isHermes === true
  );
}

/**
 * Sends the user's CDP method over an open, verified socket and awaits the
 * matching response by id.
 *
 * @param socket - The open, verified target WebSocket.
 * @param input - The original input carrying method/params/timeout.
 * @param id - The CDP message id to use.
 * @returns The matching CDP success or error response.
 */
async function sendUserMethod(
  socket: WebSocket,
  input: RunHermesCdpInput,
  id: number,
): Promise<CdpSuccessResponse | CdpErrorResponse> {
  socket.send(
    JSON.stringify({
      id,
      method: input.method,
      params: input.params ?? {},
    }),
  );
  return await waitForCdpResponse(socket, id, input.timeoutMs);
}

/**
 * Resolves once the socket reaches the OPEN state, rejecting on error or
 * timeout. Listeners are always cleaned up.
 *
 * @param socket - The connecting target WebSocket.
 * @param timeoutMs - Connection timeout in milliseconds.
 * @returns A promise that resolves when the socket is open.
 */
async function waitForSocketOpen(
  socket: WebSocket,
  timeoutMs: number,
): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let cleanup = (): void => undefined;
    const handleOpen = (): void => {
      cleanup();
      resolve();
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error('WebSocket connection error'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`WebSocket connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
    };

    socket.addEventListener('open', handleOpen);
    socket.addEventListener('error', handleError);
  });
}

/**
 * Resolves with the CDP response whose `id` matches, rejecting on socket error,
 * premature close, or timeout. Listeners are always cleaned up.
 *
 * @param socket - The open target WebSocket.
 * @param id - The CDP message id to match.
 * @param timeoutMs - Round-trip timeout in milliseconds.
 * @returns The matching CDP success or error response.
 */
async function waitForCdpResponse(
  socket: WebSocket,
  id: number,
  timeoutMs: number,
): Promise<CdpSuccessResponse | CdpErrorResponse> {
  return new Promise((resolve, reject) => {
    let cleanup = (): void => undefined;
    const handleMessage = (event: MessageEvent): void => {
      try {
        const parsed = parseCdpResponse(event.data);
        if (parsed?.id !== id) {
          return;
        }
        cleanup();
        resolve(parsed);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const handleError = (): void => {
      cleanup();
      reject(new Error('WebSocket message error'));
    };
    const handleClose = (): void => {
      cleanup();
      reject(new Error('WebSocket closed before CDP response'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Hermes CDP call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('message', handleMessage);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };

    socket.addEventListener('message', handleMessage);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);
  });
}

/**
 * Parses a raw WebSocket frame into a CDP response, returning undefined when it
 * is not an addressable (`id`-bearing) message.
 *
 * @param data - The raw `MessageEvent.data`.
 * @returns A CDP success/error response, or undefined when not addressable.
 * @throws When the frame is not a text frame.
 */
function parseCdpResponse(
  data: MessageEvent['data'],
): CdpSuccessResponse | CdpErrorResponse | undefined {
  if (typeof data !== 'string') {
    throw new Error('Hermes CDP returned a non-text WebSocket frame');
  }

  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.id !== 'number') {
    return undefined;
  }
  if (isCdpError(candidate.error)) {
    return { id: candidate.id, error: candidate.error };
  }
  return { id: candidate.id, result: candidate.result };
}

/**
 * Narrows an unknown value to a CDP error object.
 *
 * @param value - The candidate `error` field.
 * @returns True when `value` is a non-null object.
 */
function isCdpError(value: unknown): value is CdpErrorResponse['error'] {
  return typeof value === 'object' && value !== null;
}

/**
 * Discriminates a CDP response as an error response.
 *
 * @param response - A CDP success or error response.
 * @returns True when the response carries an `error` field.
 */
function isCdpErrorResponse(
  response: CdpSuccessResponse | CdpErrorResponse,
): response is CdpErrorResponse {
  return 'error' in response;
}

/**
 * Formats a CDP error response into a single human-readable line.
 *
 * @param response - The CDP error response.
 * @returns A combined message including code and data when present.
 */
function formatCdpError(response: CdpErrorResponse): string {
  const parts = [response.error.message ?? 'Unknown CDP error'];
  if (typeof response.error.code === 'number') {
    parts.push(`code ${response.error.code}`);
  }
  if (response.error.data !== undefined) {
    parts.push(JSON.stringify(response.error.data));
  }
  return parts.join(' - ');
}

/**
 * Closes the socket if it is still connecting or open.
 *
 * @param socket - The target WebSocket.
 */
function closeSocket(socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.CONNECTING ||
    socket.readyState === WebSocket.OPEN
  ) {
    socket.close();
  }
}
