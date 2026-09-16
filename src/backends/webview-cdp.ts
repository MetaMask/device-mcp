/**
 * Pure Android WebView Chrome DevTools Protocol (CDP) core for
 * `@metamask/device-mcp`.
 *
 * This module lives alongside the Android `AdbBackend` and its `adb-forward`
 * helper. It is entirely SEPARATE from the Hermes CDP path (`../hermes/`): it
 * does not modify, import, or share state with it, so the Metro/Hermes
 * local-development flow is unaffected.
 *
 * Mechanism: a debuggable Android `WebView` (an app that called
 * `WebView.setWebContentsDebuggingEnabled(true)`) exposes a Chromium remote
 * debugging endpoint over an abstract unix domain socket named
 * `webview_devtools_remote_<pid>`. The caller forwards that socket to a local
 * TCP port with `adb forward`; this module then speaks CDP over the forwarded
 * port using the GLOBAL `WebSocket` (no library) and the global `fetch` for
 * page discovery.
 *
 * Unlike Hermes, a WebView target is a real DOM page: there is no Hermes
 * identity probe, no Metro `logicalDeviceId` pinning, and no strict `appId`
 * match. The full Chrome CDP surface (`Runtime`, `DOM`, `Page`, `Input`, …) is
 * available on the page target.
 */

/**
 * A debuggable WebView page as reported by Chromium's `/json` (or `/json/list`)
 * discovery endpoint on the forwarded port.
 */
export type WebViewTarget = {
  /** Chromium's per-target identifier. */
  id?: string;
  /** Target kind — only `'page'` targets are interactable DOM pages. */
  type?: string;
  /** Human-readable page title. */
  title?: string;
  /** The page URL (used to skip empty `about:blank` shells). */
  url?: string;
  /** The `ws://` URL used to speak CDP with this page. */
  webSocketDebuggerUrl?: string;
};

/**
 * Discriminated result of a WebView CDP operation.
 *
 * On success `result` carries the raw CDP `result` payload. On failure `code`
 * is a STABLE string error code (see the `WEBVIEW_*` constants) and `message`
 * is a human-readable diagnostic.
 */
export type WebViewCdpResult =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

/**
 * Parameters for {@link runWebViewCdp}.
 */
export type RunWebViewCdpInput = {
  /** The CDP method to invoke (e.g. `Runtime.evaluate`). */
  method: string;
  /** Optional CDP method parameters. */
  params?: Record<string, unknown>;
  /** Per-call timeout in milliseconds for discovery and each CDP round-trip. */
  timeoutMs: number;
  /** The local TCP port the WebView devtools socket has been forwarded to. */
  localPort: number;
  /**
   * Optional page target selector. When set, only a page whose `url` includes
   * this substring is selected — useful when several WebViews are open. When
   * omitted, the first interactable non-blank page is used.
   */
  urlFilter?: string;
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
  | { ok: true; target: WebViewTarget }
  | { ok: false; code: string; message: string };

/**
 * No interactable WebView page target was found on the forwarded port (after
 * filtering out non-`page` targets, `about:blank` shells, and any `urlFilter`).
 */
export const WEBVIEW_TARGET_NOT_FOUND = 'WEBVIEW_TARGET_NOT_FOUND';

/**
 * The requested CDP method is in the destructive blocked set.
 */
export const WEBVIEW_BLOCKED_METHOD = 'WEBVIEW_BLOCKED_METHOD';

/**
 * The target's `webSocketDebuggerUrl` failed protocol/hostname/port validation.
 */
export const WEBVIEW_INVALID_WS_URL = 'WEBVIEW_INVALID_WS_URL';

/**
 * The underlying connection (discovery fetch or WebSocket) failed.
 */
export const WEBVIEW_CONNECTION_FAILED = 'WEBVIEW_CONNECTION_FAILED';

/**
 * A discovery, socket-open, or CDP round-trip exceeded the configured timeout.
 */
export const WEBVIEW_TIMEOUT = 'WEBVIEW_TIMEOUT';

/**
 * The user's CDP method returned a CDP-level error.
 */
export const WEBVIEW_CDP_FAILED = 'WEBVIEW_CDP_FAILED';

/**
 * The global `WebSocket` constructor is unavailable in this Node runtime.
 */
export const WEBVIEW_WEBSOCKET_UNAVAILABLE = 'WEBVIEW_WEBSOCKET_UNAVAILABLE';

/**
 * CDP methods blocked for safety. These would tear down the debugging session
 * or the browser process itself.
 */
const WEBVIEW_BLOCKED_METHODS = new Set([
  'Browser.close',
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Browser.crashGpuProcess',
]);

const DISCOVERY_PATHS = ['/json/list', '/json'];
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Orchestrates a single WebView CDP command end to end.
 *
 * Resolves a page target from the forwarded Chromium discovery endpoint,
 * validates its WebSocket URL, sends the user's method, and returns the raw CDP
 * `result`. The caller owns the `adb forward` lifecycle (setup before, teardown
 * after) — this function only speaks to the already-forwarded local port.
 *
 * @param input - Method, params, timeout, forwarded local port, and an optional
 * page url filter. See {@link RunWebViewCdpInput}.
 * @returns A discriminated {@link WebViewCdpResult}.
 */
export async function runWebViewCdp(
  input: RunWebViewCdpInput,
): Promise<WebViewCdpResult> {
  if (WEBVIEW_BLOCKED_METHODS.has(input.method)) {
    return {
      ok: false,
      code: WEBVIEW_BLOCKED_METHOD,
      message:
        `CDP method "${input.method}" is blocked for safety. ` +
        `Blocked methods: ${[...WEBVIEW_BLOCKED_METHODS].join(', ')}`,
    };
  }

  if (typeof WebSocket !== 'function') {
    return {
      ok: false,
      code: WEBVIEW_WEBSOCKET_UNAVAILABLE,
      message:
        'Global WebSocket is unavailable. On Node 20 launch device-mcp with ' +
        'NODE_OPTIONS="--experimental-websocket" (or use Node 22+).',
    };
  }

  try {
    const targets = await fetchWebViewTargets(input.localPort, input.timeoutMs);
    const selection = selectWebViewTarget(targets, input.urlFilter);
    if (!selection.ok) {
      return { ok: false, code: selection.code, message: selection.message };
    }

    const validation = validateWebViewWebSocketUrl(
      selection.target.webSocketDebuggerUrl,
      input.localPort,
    );
    if (!validation.ok) {
      return {
        ok: false,
        code: WEBVIEW_INVALID_WS_URL,
        message: validation.message,
      };
    }

    return await executeCdpCommand(selection.target, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: WEBVIEW_CONNECTION_FAILED,
      message: `WebView CDP connection failed: ${message}`,
    };
  }
}

/**
 * Fetches debuggable WebView page targets from the forwarded Chromium endpoint,
 * trying `/json/list` then falling back to `/json`. Each attempt is bounded by
 * an `AbortController` timeout. The payload must be an array; non-object entries
 * are filtered out.
 *
 * @param localPort - The forwarded local TCP port.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns The discovered targets (objects only).
 * @throws The last error encountered if all discovery paths fail.
 */
export async function fetchWebViewTargets(
  localPort: number,
  timeoutMs: number,
): Promise<WebViewTarget[]> {
  let lastError: unknown;

  for (const path of DISCOVERY_PATHS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://localhost:${localPort}${path}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`WebView ${path} returned HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`WebView ${path} returned a non-array response`);
      }

      return payload.filter(isWebViewTarget);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Narrows an unknown discovery entry to a {@link WebViewTarget} (object guard).
 *
 * @param value - A raw entry from the Chromium discovery payload.
 * @returns True when `value` is a non-null object.
 */
function isWebViewTarget(value: unknown): value is WebViewTarget {
  return typeof value === 'object' && value !== null;
}

/**
 * Selects the interactable WebView page target.
 *
 * Selection algorithm: require `webSocketDebuggerUrl` → keep only `type: 'page'`
 * targets → drop `about:blank` shells → apply the optional `urlFilter`
 * substring → return the FIRST remaining page (Chromium lists the most recently
 * focused page first).
 *
 * @param targets - All discovered targets.
 * @param urlFilter - Optional substring the page `url` must contain.
 * @returns The selected target or a classified failure.
 */
export function selectWebViewTarget(
  targets: WebViewTarget[],
  urlFilter: string | undefined,
): TargetSelection {
  const pages = targets
    .filter((target) => Boolean(target.webSocketDebuggerUrl))
    .filter((target) => target.type === undefined || target.type === 'page')
    .filter((target) => target.url !== 'about:blank')
    .filter((target) => !urlFilter || (target.url ?? '').includes(urlFilter));

  if (pages.length === 0) {
    return {
      ok: false,
      code: WEBVIEW_TARGET_NOT_FOUND,
      message: urlFilter
        ? `No debuggable WebView page found whose url contains "${urlFilter}".`
        : 'No debuggable WebView page found on the forwarded port.',
    };
  }

  return { ok: true, target: pages[0] };
}

/**
 * Validates a target's `webSocketDebuggerUrl` before connecting. The protocol
 * must be `ws:`, the hostname must be loopback, and the port must equal the
 * forwarded local port.
 *
 * @param rawUrl - The candidate `webSocketDebuggerUrl`.
 * @param expectedPort - The forwarded local port the URL must point at.
 * @returns `{ ok: true }` when valid, otherwise a failure with a message.
 */
export function validateWebViewWebSocketUrl(
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
 * Opens the target WebSocket, sends the user's method, matches the response by
 * `id`, and always closes the socket in a `finally`.
 *
 * @param target - The validated, selected page target.
 * @param input - The original {@link RunWebViewCdpInput} (method/params/timeout).
 * @returns A discriminated {@link WebViewCdpResult}.
 */
export async function executeCdpCommand(
  target: WebViewTarget,
  input: RunWebViewCdpInput,
): Promise<WebViewCdpResult> {
  if (!target.webSocketDebuggerUrl) {
    return {
      ok: false,
      code: WEBVIEW_INVALID_WS_URL,
      message: 'Target is missing webSocketDebuggerUrl',
    };
  }
  if (typeof WebSocket !== 'function') {
    return {
      ok: false,
      code: WEBVIEW_WEBSOCKET_UNAVAILABLE,
      message:
        'Global WebSocket is unavailable. On Node 20 launch device-mcp with ' +
        'NODE_OPTIONS="--experimental-websocket" (or use Node 22+).',
    };
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);

  try {
    await waitForSocketOpen(socket, input.timeoutMs);

    socket.send(
      JSON.stringify({
        id: 1,
        method: input.method,
        params: input.params ?? {},
      }),
    );
    const response = await waitForCdpResponse(socket, 1, input.timeoutMs);

    if (isCdpErrorResponse(response)) {
      return {
        ok: false,
        code: WEBVIEW_CDP_FAILED,
        message: `WebView CDP "${input.method}" failed: ${formatCdpError(
          response,
        )}`,
      };
    }

    return { ok: true, result: response.result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('timed out')) {
      return {
        ok: false,
        code: WEBVIEW_TIMEOUT,
        message: `WebView CDP "${input.method}" timed out after ${input.timeoutMs}ms`,
      };
    }
    return {
      ok: false,
      code: WEBVIEW_CONNECTION_FAILED,
      message: `WebView CDP connection failed: ${message}`,
    };
  } finally {
    closeSocket(socket);
  }
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
      reject(new Error(`WebView CDP call timed out after ${timeoutMs}ms`));
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
 * is not an addressable (`id`-bearing) message (e.g. a CDP event).
 *
 * @param data - The raw `MessageEvent.data`.
 * @returns A CDP success/error response, or undefined when not addressable.
 * @throws When the frame is not a text frame.
 */
function parseCdpResponse(
  data: MessageEvent['data'],
): CdpSuccessResponse | CdpErrorResponse | undefined {
  if (typeof data !== 'string') {
    throw new Error('WebView CDP returned a non-text WebSocket frame');
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
