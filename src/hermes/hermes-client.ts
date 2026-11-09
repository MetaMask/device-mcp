/**
 * Persistent Hermes Chrome DevTools Protocol (CDP) client for
 * `@metamask/device-mcp`.
 *
 * `runHermesCdp` opens one WebSocket per call, which costs a `/json` discovery
 * fetch and a handshake every time and cannot receive CDP events. This client
 * keeps ONE verified socket open for many calls and dispatches the CDP events
 * (messages without an `id`, e.g. `Runtime.consoleAPICalled`) to listeners.
 *
 * It keeps every fail-closed safety check of the one-shot path: strict `appId`
 * selection, the Hermes identity probe once per socket, the device pin, the
 * WebSocket URL validation, and the blocked-method set.
 *
 * When Metro restarts (or the socket is otherwise lost) the socket closes.
 * Pending calls are failed with `HERMES_CONNECTION_FAILED` and NOT resent (they
 * may have run), then the client rediscovers the target and reconnects with
 * exponential backoff. Every successful (re)connect emits `contextCreated`.
 *
 * An app reload does NOT close the socket: the runtime swaps its JavaScript
 * context in place. With `trackContexts` on (the default) the client enables
 * `Runtime` context events, emits `contextDestroyed` when the old context goes
 * away and `contextCreated` (`reason: 'reload'`) for the new one, so callers can
 * re-apply their scripts.
 */

import type { HermesCdpResult } from './hermes-cdp.js';
import {
  closeSocket,
  createBlockedMethodResult,
  fetchDiscoveryTargets,
  formatCdpError,
  HERMES_ABORTED,
  HERMES_CDP_FAILED,
  HERMES_CONNECTION_FAILED,
  HERMES_DEVICE_PIN_MISMATCH,
  HERMES_INVALID_WS_URL,
  HERMES_NOT_VERIFIED,
  HERMES_TARGET_NOT_FOUND,
  HERMES_TIMEOUT,
  HERMES_WEBSOCKET_UNAVAILABLE,
  resolveWebSocketOrigin,
  runIdentityProbe,
  selectHermesTarget,
  validateWebSocketUrl,
  waitForSocketOpen,
  websocketUnavailableResult,
} from './hermes-cdp.js';

/** Default first backoff delay after an unexpected disconnect. */
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 250;

/** Default upper bound for the exponential backoff delay. */
const DEFAULT_RECONNECT_MAX_DELAY_MS = 5_000;

/** Default number of automatic reconnect attempts before giving up. */
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 6;

/** Default connect timeout used by the automatic reconnect loop. */
const DEFAULT_RECONNECT_TIMEOUT_MS = 10_000;

/** Lifecycle event name used to report a throwing listener. */
const LISTENER_ERROR_EVENT = 'listenerError';

/** Message used when a call is made after {@link HermesClient.close}. */
const CLIENT_CLOSED_MESSAGE = 'HermesClient is closed';

/**
 * Options for the automatic reconnect loop.
 */
export type HermesClientReconnectOptions = {
  /** First backoff delay in milliseconds (doubles on every attempt). */
  initialDelayMs?: number;
  /** Upper bound for the backoff delay in milliseconds. */
  maxDelayMs?: number;
  /**
   * Number of attempts before giving up. When the loop gives up the client
   * reports itself disconnected and the next {@link HermesClient.send} tries a
   * fresh connect. `0` disables auto-reconnect.
   */
  maxAttempts?: number;
  /**
   * Connect timeout for automatic reconnect attempts, in milliseconds
   * (default 10 s). Per-call `timeoutMs` values only apply to the call's own
   * connect, so a short call timeout never shortens later reconnect attempts.
   */
  connectTimeoutMs?: number;
};

/**
 * Options for constructing a {@link HermesClient}.
 */
export type HermesClientOptions = {
  /** The resolved Metro inspector proxy port. */
  metroPort: number;
  /** The expected app bundle identifier (strict-matched against targets). */
  appId: string;
  /** Override the HTTP(S) Origin for Metro's debugger WebSocket handshake. */
  origin?: string;
  /** The pinned `logicalDeviceId` for this session, if one has been set. */
  pinnedDeviceId?: string;
  /**
   * Callback invoked with the resolved `logicalDeviceId` on the FIRST
   * successful identity probe so the caller can persist the pin.
   */
  onPin?: (logicalDeviceId: string) => void;
  /** Automatic reconnect tuning. */
  reconnect?: HermesClientReconnectOptions;
  /**
   * Track JavaScript execution contexts and emit `contextCreated` /
   * `contextDestroyed` lifecycle events (default `true`).
   *
   * When enabled, the client sends `Runtime.enable` itself after each
   * connection so Hermes streams `Runtime.executionContextCreated`,
   * `Runtime.executionContextDestroyed` and `Runtime.executionContextsCleared`
   * over the socket; an app reload keeps the socket open, so this is the only
   * signal that the JavaScript context was replaced. Cost: `Runtime.enable`
   * also makes Hermes stream `Runtime.consoleAPICalled` (and other `Runtime`
   * events) on the socket; listeners that do not consume them still receive
   * them.
   */
  trackContexts?: boolean;
};

/**
 * Options for {@link HermesClient.connect}.
 */
export type HermesConnectOptions = {
  /** Timeout in milliseconds for discovery, the socket open and the probe. */
  timeoutMs: number;
};

/**
 * The verified target the client is (or was last) connected to.
 */
export type HermesConnectedTarget = {
  /** Metro's per-target identifier (changes after an app reload). */
  id: string | undefined;
  /** The verified `reactNative.logicalDeviceId` of the target. */
  logicalDeviceId: string;
  /** Human-readable target title. */
  title: string | undefined;
};

/**
 * The failure branch shared by the connect and send results.
 */
type HermesFailureResult = { ok: false; code: string; message: string };

/**
 * Result of {@link HermesClient.connect}.
 */
export type HermesConnectResult =
  | { ok: true; target: HermesConnectedTarget }
  | HermesFailureResult;

/**
 * Options for {@link HermesClient.send}.
 */
export type HermesSendOptions = {
  /** Per-call timeout in milliseconds. */
  timeoutMs: number;
  /** Aborts the call; the pending response is discarded. */
  signal?: AbortSignal;
};

/**
 * A CDP event: a message without an `id` that carries a `method`.
 */
export type HermesCdpEvent = {
  /** The CDP event method, e.g. `Runtime.consoleAPICalled`. */
  method: string;
  /** The event payload as sent by Hermes. */
  params: unknown;
};

/**
 * Why a `contextCreated` lifecycle event fired:
 * - `connect`: the first connection of this client.
 * - `reconnect`: a new socket after the old one closed (Metro restart, socket
 *   loss).
 * - `reload`: a new JS context on the SAME socket (app reload / fast refresh).
 */
export type HermesContextCreatedReason = 'connect' | 'reconnect' | 'reload';

/**
 * Payload of the `contextCreated` lifecycle event: emitted after every
 * successful connect, after every reconnect, and for every new JavaScript
 * execution context created on an open socket (app reload).
 */
export type HermesContextCreatedEvent = {
  /** The verified target of the connection. */
  target: HermesConnectedTarget;
  /** True for a reconnect, false for the initial connect or a reload. */
  reconnected: boolean;
  /** Why the event fired. */
  reason: HermesContextCreatedReason;
  /** The CDP execution context id for a `reload`, when Hermes reported one. */
  executionContextId?: number;
};

/**
 * Payload of the `contextDestroyed` lifecycle event, emitted when an open
 * socket reports that its JavaScript context went away (a reload started).
 */
export type HermesContextDestroyedEvent = {
  /** Contexts are only destroyed by a reload on the same socket. */
  reason: 'reload';
};

/**
 * Payload of the `disconnected` lifecycle event.
 */
export type HermesDisconnectedEvent = {
  /** Why the socket was lost (close reason or `WebSocket error`). */
  reason: string;
};

/**
 * Payload of the `reconnected` lifecycle event, emitted just before the
 * `contextCreated` event of a successful automatic reconnect.
 */
export type HermesReconnectedEvent = {
  /** The verified target of the new connection. */
  target: HermesConnectedTarget;
  /** How many backoff attempts were needed. */
  attempts: number;
};

/**
 * Payload of the `listenerError` lifecycle event, emitted when one of the
 * client's own listeners throws. The exception is isolated so it cannot break
 * the socket handler or the other listeners; this event surfaces it.
 */
export type HermesListenerErrorEvent = {
  /** The event name whose listener threw. */
  event: string;
  /** The thrown value. */
  error: unknown;
};

/**
 * Lifecycle events with a typed payload. Any other event name is a CDP event
 * and receives a {@link HermesCdpEvent}.
 */
export type HermesClientEventMap = {
  contextCreated: HermesContextCreatedEvent;
  contextDestroyed: HermesContextDestroyedEvent;
  disconnected: HermesDisconnectedEvent;
  reconnected: HermesReconnectedEvent;
  listenerError: HermesListenerErrorEvent;
};

type HermesClientStatus = 'idle' | 'connecting' | 'open' | 'closed';

type HermesEventListener = (payload: never) => void;

type PendingCall = {
  /** The CDP method, used in error messages. */
  method: string;
  /** Per-call timeout handle. */
  timer: ReturnType<typeof setTimeout>;
  /** Removes the abort listener, if one was registered. */
  detachAbort: () => void;
  /** Resolves the caller exactly once. */
  resolve: (result: HermesCdpResult) => void;
};

/**
 * Persistent, verified Hermes CDP connection.
 *
 * Create one per session, call {@link send} for CDP methods (it connects on the
 * first call), subscribe with {@link on}, and call {@link close} when done.
 *
 * Reloads keep the socket open, so a closed socket only means a lost connection
 * (Metro restart). When `trackContexts` is on (the default), the client enables
 * `Runtime` context events and emits a `contextCreated` lifecycle event for
 * every new JavaScript context on the open socket, so callers can re-apply
 * their scripts.
 *
 * An unexpected socket loss starts a background reconnect loop. A caller's
 * {@link connect} or {@link send} never stops that loop: while the connection is
 * lost, a failed caller-driven attempt (re)starts it, and a successful one is
 * reported as `contextCreated` with `reason: 'reconnect'`.
 *
 * A listener that throws is isolated and reported through the `listenerError`
 * lifecycle event; it never breaks the socket handler or the other listeners.
 */
export class HermesClient {
  readonly #metroPort: number;

  readonly #appId: string;

  readonly #origin: string | undefined;

  readonly #onPin: ((logicalDeviceId: string) => void) | undefined;

  readonly #reconnect: Required<HermesClientReconnectOptions>;

  readonly #trackContexts: boolean;

  readonly #listeners = new Map<string, Set<HermesEventListener>>();

  readonly #pending = new Map<number, PendingCall>();

  #pinnedDeviceId: string | undefined;

  #socket: WebSocket | undefined;

  /**
   * The socket of an in-flight connect, before it is adopted. Kept so
   * {@link close} can abandon the connect promptly.
   */
  #connectingSocket: WebSocket | undefined;

  #target: HermesConnectedTarget | undefined;

  #status: HermesClientStatus = 'idle';

  #nextId = 1;

  /**
   * Whether the adopted socket streams `Runtime` execution-context events.
   * True while `Runtime.enable` is in flight or succeeded; false when
   * `trackContexts` is off or `Runtime.enable` failed.
   */
  #socketTracksContexts = false;

  /**
   * Whether the first execution context of the adopted socket was already seen.
   * The connect `contextCreated` event covers it, so it is not re-emitted.
   */
  #sawContextOnSocket = false;

  /**
   * Whether a `contextDestroyed` event was already emitted for the current
   * reload; coalesces `executionContextDestroyed` and
   * `executionContextsCleared`. Also marks a reload in progress, so the next
   * context is reported as `reload` even when the socket never reported its
   * first context.
   */
  #contextDestroyedForReload = false;

  /**
   * Whether the last connection was lost unexpectedly (not through
   * {@link close}). Set on an unexpected loss, cleared on a successful connect
   * and by {@link close}. Drives the `reconnect` reason of a caller-driven
   * connect and whether a failed caller-driven attempt restarts the loop.
   */
  #socketLost = false;

  #inFlightConnect: Promise<HermesConnectResult> | undefined;

  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  #reconnectAttempt = 0;

  #explicitlyClosed = false;

  constructor(options: HermesClientOptions) {
    this.#metroPort = options.metroPort;
    this.#appId = options.appId;
    this.#origin = options.origin;
    this.#pinnedDeviceId = options.pinnedDeviceId;
    this.#onPin = options.onPin;
    this.#trackContexts = options.trackContexts ?? true;
    this.#reconnect = {
      initialDelayMs:
        options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs:
        options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      maxAttempts:
        options.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS,
      connectTimeoutMs:
        options.reconnect?.connectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS,
    };
  }

  /**
   * The Metro inspector proxy port this client discovers targets on.
   *
   * @returns The configured port.
   */
  get metroPort(): number {
    return this.#metroPort;
  }

  /**
   * The app bundle identifier this client strictly matches targets against.
   *
   * @returns The configured app id.
   */
  get appId(): string {
    return this.#appId;
  }

  /**
   * Whether an adopted, verified socket is currently open.
   *
   * @returns True while the client can send without connecting.
   */
  get isConnected(): boolean {
    return this.#status === 'open' && this.#socket !== undefined;
  }

  /**
   * Discovers, opens, verifies and adopts a Hermes target.
   *
   * Idempotent: when already connected it resolves with the current target, and
   * concurrent callers share one in-flight connect (one discovery fetch, one
   * socket, one identity probe). Emits `contextCreated` on success, with
   * `reason: 'reconnect'` when the previous connection was lost unexpectedly.
   * A client closed with {@link close} reopens.
   *
   * A connect never stops the background reconnect loop: a failed attempt while
   * the connection is lost restarts it.
   *
   * @param options - The connect timeout.
   * @returns The verified target or a classified failure.
   */
  async connect(options: HermesConnectOptions): Promise<HermesConnectResult> {
    const { timeoutMs } = options;
    this.#explicitlyClosed = false;

    if (this.isConnected && this.#target) {
      return { ok: true, target: this.#target };
    }

    const result = await this.#connectOnce(timeoutMs);
    this.#resumeReconnectAfterFailedCall(result);
    return result;
  }

  /**
   * Sends one CDP method over the persistent socket and awaits its response.
   *
   * Connects first when needed. Many calls can be in flight: responses are
   * matched by CDP `id`. On timeout the call fails with `HERMES_TIMEOUT`; on
   * abort with `HERMES_ABORTED`. Both remove the pending entry, so a late
   * response is ignored. A CDP-level error becomes `HERMES_CDP_FAILED`.
   *
   * @param method - The CDP method, e.g. `Runtime.evaluate`.
   * @param params - The CDP parameters.
   * @param options - Per-call timeout and optional abort signal.
   * @returns The raw CDP `result`, or a classified failure.
   */
  async send(
    method: string,
    params: Record<string, unknown> | undefined,
    options: HermesSendOptions,
  ): Promise<HermesCdpResult> {
    const { timeoutMs, signal } = options;

    const blocked = createBlockedMethodResult(method);
    if (blocked) {
      return blocked;
    }
    if (this.#explicitlyClosed) {
      return {
        ok: false,
        code: HERMES_CONNECTION_FAILED,
        message: CLIENT_CLOSED_MESSAGE,
      };
    }
    if (signal?.aborted) {
      return abortedResult(method);
    }

    if (!this.isConnected) {
      const connected = await this.#connectWithAbort(timeoutMs, signal);
      if (connected === undefined) {
        return abortedResult(method);
      }
      if (!connected.ok) {
        return connected;
      }
    }
    if (signal?.aborted) {
      return abortedResult(method);
    }

    const socket = this.#socket;
    if (socket === undefined) {
      return connectionNotOpenResult();
    }
    if (socket.readyState !== WebSocket.OPEN) {
      return connectionNotOpenResult();
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<HermesCdpResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#settle(id, {
          ok: false,
          code: HERMES_TIMEOUT,
          message: `Hermes CDP call timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      unrefTimer(timer);

      let detachAbort = (): void => undefined;
      if (signal) {
        const handleAbort = (): void => {
          this.#settle(id, abortedResult(method));
        };
        signal.addEventListener('abort', handleAbort);
        detachAbort = (): void => {
          signal.removeEventListener('abort', handleAbort);
        };
      }

      this.#pending.set(id, { method, timer, detachAbort, resolve });
    });

    try {
      socket.send(JSON.stringify({ id, method, params: params ?? {} }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#settle(id, {
        ok: false,
        code: HERMES_CONNECTION_FAILED,
        message: `Hermes CDP connection failed: ${message}`,
      });
    }

    return await response;
  }

  /**
   * Subscribes to a lifecycle event or a CDP event.
   *
   * Lifecycle names are `contextCreated`, `contextDestroyed`, `disconnected`
   * and `reconnected`. Any other name receives the CDP event messages of that
   * `method` (for example `Runtime.consoleAPICalled`).
   *
   * @param event - The lifecycle event name or CDP method name.
   * @param listener - Called with the typed lifecycle payload or the CDP event.
   */
  on<EventName extends keyof HermesClientEventMap>(
    event: EventName,
    listener: (payload: HermesClientEventMap[EventName]) => void,
  ): void;

  on(event: string, listener: (payload: HermesCdpEvent) => void): void;

  on(event: string, listener: HermesEventListener): void {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  /**
   * Removes a listener previously added with {@link on}.
   *
   * @param event - The event name the listener was registered for.
   * @param listener - The listener reference to remove.
   */
  off<EventName extends keyof HermesClientEventMap>(
    event: EventName,
    listener: (payload: HermesClientEventMap[EventName]) => void,
  ): void;

  off(event: string, listener: (payload: HermesCdpEvent) => void): void;

  off(event: string, listener: HermesEventListener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  /**
   * Stops reconnecting, closes the socket and fails pending calls.
   *
   * Idempotent. A later {@link connect} reopens the client.
   */
  close(): void {
    this.#explicitlyClosed = true;
    this.#socketLost = false;
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
    this.#failAllPending(
      HERMES_CONNECTION_FAILED,
      `${CLIENT_CLOSED_MESSAGE}: the connection was closed`,
    );

    const socket = this.#socket;
    this.#socket = undefined;
    this.#target = undefined;
    this.#status = 'closed';

    if (socket) {
      this.#detachSocket();
      closeSocket(socket);
    }

    const connecting = this.#connectingSocket;
    this.#connectingSocket = undefined;
    if (connecting) {
      closeSocket(connecting);
    }
  }

  /**
   * Shares one in-flight connect between concurrent callers and emits the
   * connect lifecycle events once.
   *
   * The `reconnect` reason is taken from the connection state at the start of
   * the attempt: after an unexpected socket loss the next successful connect is
   * a reconnect, whether the background loop or a caller triggered it.
   *
   * @param timeoutMs - The connect timeout.
   * @param reconnectAttempts - Set for a background reconnect attempt, used for
   * the `reconnected` payload. A caller-driven reconnect only emits
   * `contextCreated`.
   * @returns The connect result.
   */
  async #connectOnce(
    timeoutMs: number,
    reconnectAttempts?: number,
  ): Promise<HermesConnectResult> {
    const existing = this.#inFlightConnect;
    if (existing) {
      return await existing;
    }

    const reconnected = this.#socketLost;
    const promise = this.#doConnect(timeoutMs, reconnected)
      .then((result) => {
        if (result.ok) {
          this.#socketLost = false;
          this.#resetReconnect();
          if (reconnectAttempts !== undefined) {
            this.#emit('reconnected', {
              target: result.target,
              attempts: reconnectAttempts,
            });
          }
          this.#emit('contextCreated', {
            target: result.target,
            reconnected,
            reason: reconnected ? 'reconnect' : 'connect',
          });
        }
        return result;
      })
      .finally(() => {
        if (this.#inFlightConnect === promise) {
          this.#inFlightConnect = undefined;
        }
      });

    this.#inFlightConnect = promise;
    return await promise;
  }

  /**
   * Discovers, opens, probes and adopts a target. Never throws.
   *
   * @param timeoutMs - The connect timeout.
   * @param reconnected - True when the previous connection was lost
   * unexpectedly, used to fail closed on a device pin mismatch.
   * @returns The verified target or a classified failure.
   */
  async #doConnect(
    timeoutMs: number,
    reconnected: boolean,
  ): Promise<HermesConnectResult> {
    if (typeof WebSocket !== 'function') {
      this.#status = 'closed';
      return websocketUnavailableResult();
    }

    this.#status = 'connecting';
    let socket: WebSocket | undefined;
    let adopted = false;

    try {
      const targets = await fetchDiscoveryTargets(this.#metroPort, timeoutMs);
      if (this.#explicitlyClosed) {
        return closedDuringConnectResult();
      }

      const selection = selectHermesTarget(
        targets,
        this.#appId,
        this.#pinnedDeviceId,
      );
      if (!selection.ok) {
        const pinMismatch = this.#detectReconnectPinMismatch(
          targets,
          selection.code,
          reconnected,
        );
        if (pinMismatch) {
          return pinMismatch;
        }
        return {
          ok: false,
          code: selection.code,
          message: selection.message,
        };
      }

      const url = selection.target.webSocketDebuggerUrl;
      if (!url) {
        return {
          ok: false,
          code: HERMES_INVALID_WS_URL,
          message: 'Target is missing webSocketDebuggerUrl',
        };
      }
      const validation = validateWebSocketUrl(url, this.#metroPort);
      if (!validation.ok) {
        return {
          ok: false,
          code: HERMES_INVALID_WS_URL,
          message: validation.message,
        };
      }

      const origin = resolveWebSocketOrigin(url, this.#origin);
      const WebSocketWithHeaders = WebSocket as typeof WebSocket &
        (new (
          wsUrl: string,
          options: { headers: { origin: string } },
        ) => WebSocket);
      const connectingSocket = new WebSocketWithHeaders(url, {
        headers: { origin },
      });
      socket = connectingSocket;
      this.#connectingSocket = connectingSocket;

      await waitForSocketOpen(connectingSocket, timeoutMs);
      if (this.#explicitlyClosed) {
        return closedDuringConnectResult();
      }

      // The probe runs once per socket, with id 1; user calls start at 2.
      const probe = await runIdentityProbe(connectingSocket, timeoutMs, 1);
      if (!probe.ok) {
        return { ok: false, code: probe.code, message: probe.message };
      }
      // Checked after every await of the connect path: a close() during the
      // connect must not pin the device, call `onPin` or adopt the socket.
      if (this.#explicitlyClosed) {
        return closedDuringConnectResult();
      }

      const targetDeviceId = selection.target.reactNative?.logicalDeviceId;
      if (!targetDeviceId) {
        return {
          ok: false,
          code: HERMES_NOT_VERIFIED,
          message: 'Target is missing reactNative.logicalDeviceId',
        };
      }
      if (this.#pinnedDeviceId === undefined) {
        this.#pinnedDeviceId = targetDeviceId;
        this.#onPin?.(targetDeviceId);
      } else if (this.#pinnedDeviceId !== targetDeviceId) {
        return {
          ok: false,
          code: HERMES_DEVICE_PIN_MISMATCH,
          message: `Hermes target device ${targetDeviceId} does not match session pin ${this.#pinnedDeviceId}`,
        };
      }

      this.#adopt(connectingSocket);
      adopted = true;
      this.#status = 'open';

      const target: HermesConnectedTarget = {
        id: selection.target.id,
        logicalDeviceId: targetDeviceId,
        title: selection.target.title,
      };
      this.#target = target;

      if (this.#trackContexts) {
        // Mark tracking before sending: Hermes can emit the first
        // `executionContextCreated` before the `Runtime.enable` response, and
        // that first context must be recorded (so a later reload is not
        // mistaken for it) even though it is not re-emitted.
        this.#socketTracksContexts = true;
        // Enabling contexts is best effort: a failure only disables the
        // `contextCreated` / `contextDestroyed` lifecycle detection for this
        // socket, it never fails the connect.
        const enabled = await this.send('Runtime.enable', undefined, {
          timeoutMs,
        });
        if (!enabled.ok) {
          this.#socketTracksContexts = false;
          this.#sawContextOnSocket = false;
          if (!this.isConnected) {
            return {
              ok: false,
              code: HERMES_CONNECTION_FAILED,
              message:
                'Hermes CDP connection failed: the socket closed while enabling runtime events',
            };
          }
        }
      }

      return { ok: true, target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: HERMES_CONNECTION_FAILED,
        message: `Hermes CDP connection failed: ${message}`,
      };
    } finally {
      if (this.#connectingSocket === socket) {
        this.#connectingSocket = undefined;
      }
      if (!adopted) {
        this.#status = 'closed';
        if (socket) {
          closeSocket(socket);
        }
      }
    }
  }

  /**
   * Awaits a connect, giving up with `undefined` as soon as the signal aborts.
   * The shared connect itself keeps running for other callers.
   *
   * @param timeoutMs - The connect timeout.
   * @param signal - The call's abort signal, if any.
   * @returns The connect result, or undefined when the call was aborted.
   */
  async #connectWithAbort(
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<HermesConnectResult | undefined> {
    const connecting = this.connect({ timeoutMs });
    if (!signal) {
      return await connecting;
    }
    if (signal.aborted) {
      return undefined;
    }

    let handleAbort = (): void => undefined;
    const aborted = new Promise<undefined>((resolve) => {
      handleAbort = (): void => resolve(undefined);
      signal.addEventListener('abort', handleAbort, { once: true });
    });

    try {
      return await Promise.race([connecting, aborted]);
    } finally {
      signal.removeEventListener('abort', handleAbort);
    }
  }

  /**
   * Restarts the reconnect loop after a caller-driven connect failed while the
   * connection was lost, so a `send` during the reconnect wait cannot stop the
   * background loop.
   *
   * Does nothing after {@link close} or when the failure is terminal (device
   * pin mismatch, WebSocket unavailable): retrying cannot fix those.
   *
   * @param result - The failed caller-driven connect result.
   */
  #resumeReconnectAfterFailedCall(result: HermesConnectResult): void {
    if (result.ok || !this.#socketLost || this.#explicitlyClosed) {
      return;
    }
    if (
      result.code === HERMES_DEVICE_PIN_MISMATCH ||
      result.code === HERMES_WEBSOCKET_UNAVAILABLE
    ) {
      return;
    }
    this.#scheduleReconnect();
  }

  /**
   * Turns a pinned selection failure into `HERMES_DEVICE_PIN_MISMATCH` during a
   * reconnect when Metro reports a different device. Inspection only: no socket
   * is opened for the wrong device.
   *
   * @param targets - All discovered targets.
   * @param code - The selection failure code.
   * @param reconnected - True when the previous connection was lost.
   * @returns The mismatch result, or undefined to keep the selection failure.
   */
  #detectReconnectPinMismatch(
    targets: Parameters<typeof selectHermesTarget>[0],
    code: string,
    reconnected: boolean,
  ): { ok: false; code: string; message: string } | undefined {
    const pinnedDeviceId = this.#pinnedDeviceId;
    if (!reconnected || !pinnedDeviceId || code !== HERMES_TARGET_NOT_FOUND) {
      return undefined;
    }

    const unpinned = selectHermesTarget(targets, this.#appId, undefined);
    if (!unpinned.ok) {
      return undefined;
    }
    const deviceId =
      unpinned.target.reactNative?.logicalDeviceId ?? '<missing>';
    if (deviceId === pinnedDeviceId) {
      return undefined;
    }
    return {
      ok: false,
      code: HERMES_DEVICE_PIN_MISMATCH,
      message: `Hermes target device ${deviceId} does not match session pin ${pinnedDeviceId}`,
    };
  }

  /**
   * Adopts an open, verified socket: installs the dispatcher, resets the CDP id
   * sequence for the new connection and closes any socket it replaces, so a
   * reconnect never leaks the previous socket.
   *
   * @param socket - The verified socket.
   */
  #adopt(socket: WebSocket): void {
    const previous = this.#socket;
    this.#detachSocket();
    this.#socket = socket;
    if (previous && previous !== socket) {
      closeSocket(previous);
    }
    this.#nextId = 2;
    this.#socketTracksContexts = false;
    this.#sawContextOnSocket = false;
    this.#contextDestroyedForReload = false;
    socket.addEventListener('message', this.#handleMessage);
    socket.addEventListener('close', this.#handleClose);
    socket.addEventListener('error', this.#handleError);
  }

  /**
   * Removes this client's listeners from the adopted socket, if any.
   */
  #detachSocket(): void {
    const socket = this.#socket;
    if (!socket) {
      return;
    }
    socket.removeEventListener('message', this.#handleMessage);
    socket.removeEventListener('close', this.#handleClose);
    socket.removeEventListener('error', this.#handleError);
  }

  /**
   * Dispatches one WebSocket frame: settles a matching pending call, or emits
   * the frame as a CDP event.
   *
   * @param event - The WebSocket message event.
   */
  readonly #handleMessage = (event: MessageEvent): void => {
    if (typeof event.data !== 'string') {
      this.#onSocketLost(
        'Hermes CDP returned a non-text WebSocket frame',
        'Hermes CDP connection failed: Hermes CDP returned a non-text WebSocket frame',
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }

    const message = parsed as Record<string, unknown>;
    if (typeof message.id === 'number') {
      this.#handleResponse(message);
      return;
    }
    if (typeof message.method === 'string') {
      this.#emit(message.method, {
        method: message.method,
        params: message.params,
      });
      this.#trackExecutionContext(message.method, message.params);
    }
  };

  /**
   * Derives `contextCreated` / `contextDestroyed` lifecycle events from the
   * `Runtime` execution-context events of the adopted socket.
   *
   * The first context of a socket is the one the connect `contextCreated` event
   * already described, so it is not re-emitted. A later context means the app
   * reloaded while the socket stayed open.
   *
   * @param method - The CDP event method.
   * @param params - The CDP event payload.
   */
  #trackExecutionContext(method: string, params: unknown): void {
    if (!this.#socketTracksContexts) {
      return;
    }

    if (method === 'Runtime.executionContextCreated') {
      this.#handleExecutionCreated(params);
      return;
    }
    if (
      method === 'Runtime.executionContextDestroyed' ||
      method === 'Runtime.executionContextsCleared'
    ) {
      if (this.#contextDestroyedForReload) {
        return;
      }
      this.#contextDestroyedForReload = true;
      this.#emit('contextDestroyed', { reason: 'reload' });
    }
  }

  /**
   * Emits `contextCreated` for a reload.
   *
   * The first context of a socket is covered by the connect event and is not
   * re-emitted, unless a `contextDestroyed{reload}` was already seen on this
   * socket: some devices do not report the initial context, so the next one
   * after a destroy is a reload, not the socket's first context.
   *
   * @param params - The `Runtime.executionContextCreated` payload.
   */
  #handleExecutionCreated(params: unknown): void {
    const executionContextId = readExecutionContextId(params);
    if (!this.#sawContextOnSocket) {
      this.#sawContextOnSocket = true;
      if (!this.#contextDestroyedForReload) {
        return;
      }
    }

    const target = this.#target;
    if (!target) {
      return;
    }

    this.#contextDestroyedForReload = false;
    const event: HermesContextCreatedEvent = {
      target,
      reconnected: false,
      reason: 'reload',
    };
    if (executionContextId !== undefined) {
      event.executionContextId = executionContextId;
    }
    this.#emit('contextCreated', event);
  }

  /**
   * Settles the pending call whose id matches a CDP response.
   *
   * @param message - The parsed CDP response.
   */
  #handleResponse(message: Record<string, unknown>): void {
    const id = message.id as number;
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }

    if (typeof message.error === 'object' && message.error !== null) {
      this.#settle(id, {
        ok: false,
        code: HERMES_CDP_FAILED,
        message: `Hermes CDP "${pending.method}" failed: ${formatCdpError(
          message.error,
        )}`,
      });
      return;
    }
    this.#settle(id, { ok: true, result: message.result });
  }

  /**
   * Handles a socket close event from the adopted socket.
   *
   * @param event - The close event, read for its reason.
   */
  readonly #handleClose = (event: Event): void => {
    if (!this.#socket) {
      return;
    }
    this.#onSocketLost(readCloseReason(event));
  };

  /**
   * Handles a socket error event. Node follows it with `close`; the adopted
   * socket is released here so the error is not lost if it does not.
   */
  readonly #handleError = (): void => {
    this.#onSocketLost(
      'WebSocket error',
      'Hermes CDP connection failed: WebSocket message error',
    );
  };

  /**
   * Releases the adopted socket after an unexpected loss, fails pending calls,
   * starts the reconnect loop and then emits `disconnected`.
   *
   * The loop starts first on purpose: a `disconnected` listener may call
   * {@link send}, and the socket it opens must already be the one the next
   * scheduled attempt finds.
   *
   * @param reason - Why the socket was lost, used for the `disconnected` event.
   * @param pendingMessage - Overrides the pending-call failure message.
   */
  #onSocketLost(reason: string, pendingMessage?: string): void {
    const socket = this.#socket;
    if (!socket) {
      return;
    }

    this.#detachSocket();
    this.#socket = undefined;
    this.#target = undefined;
    this.#status = 'closed';
    this.#socketLost = true;
    closeSocket(socket);

    this.#failAllPending(
      HERMES_CONNECTION_FAILED,
      pendingMessage ?? `Hermes CDP connection closed: ${reason}`,
    );

    if (!this.#explicitlyClosed) {
      this.#startReconnect();
    }
    this.#emit('disconnected', { reason });
  }

  /**
   * Restarts the reconnect loop from the first backoff delay.
   */
  #startReconnect(): void {
    if (this.#explicitlyClosed || this.#reconnectTimer !== undefined) {
      return;
    }
    this.#reconnectAttempt = 0;
    this.#scheduleReconnect();
  }

  /**
   * Schedules the next reconnect attempt with exponential backoff, or gives up
   * after `maxAttempts` (the client then reports itself disconnected and the
   * next {@link send} tries a fresh connect).
   */
  #scheduleReconnect(): void {
    if (this.#explicitlyClosed || this.#reconnectTimer !== undefined) {
      return;
    }
    if (this.#reconnectAttempt >= this.#reconnect.maxAttempts) {
      this.#status = 'closed';
      return;
    }

    const delay = Math.min(
      this.#reconnect.initialDelayMs * 2 ** this.#reconnectAttempt,
      this.#reconnect.maxDelayMs,
    );
    this.#reconnectAttempt += 1;

    const timer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#attemptReconnect().catch(() => undefined);
    }, delay);
    unrefTimer(timer);
    this.#reconnectTimer = timer;
  }

  /**
   * Runs one reconnect attempt.
   *
   * Does nothing when the client is already connected: a caller (for example a
   * `disconnected` listener) may have connected before the timer fired, and a
   * second socket must never be opened. Failures schedule the next backoff
   * step; a device pin mismatch or a missing WebSocket stops the loop so the
   * wrong device is never used.
   */
  async #attemptReconnect(): Promise<void> {
    if (this.#explicitlyClosed) {
      return;
    }
    if (this.isConnected) {
      this.#resetReconnect();
      return;
    }
    try {
      const result = await this.#connectOnce(
        this.#reconnect.connectTimeoutMs,
        this.#reconnectAttempt,
      );
      if (this.#explicitlyClosed) {
        return;
      }
      if (result.ok || this.isConnected) {
        this.#resetReconnect();
        return;
      }
      if (
        result.code === HERMES_DEVICE_PIN_MISMATCH ||
        result.code === HERMES_WEBSOCKET_UNAVAILABLE
      ) {
        this.#status = 'closed';
        return;
      }
      this.#scheduleReconnect();
    } catch {
      this.#scheduleReconnect();
    }
  }

  /**
   * Clears the pending reconnect timer and resets the backoff counter.
   */
  #resetReconnect(): void {
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
  }

  /**
   * Clears the pending reconnect timer, if any.
   */
  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
  }

  /**
   * Fails every pending call with the same code and message.
   *
   * @param code - The stable error code.
   * @param message - The human-readable message.
   */
  #failAllPending(code: string, message: string): void {
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, { ok: false, code, message });
    }
  }

  /**
   * Resolves one pending call and removes it, so a late response is ignored.
   *
   * @param id - The CDP message id of the pending call.
   * @param result - The result to resolve with.
   */
  #settle(id: number, result: HermesCdpResult): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.detachAbort();
    pending.resolve(result);
  }

  /**
   * Calls every listener registered for an event.
   *
   * A throwing listener is isolated (the socket handler and the other listeners
   * keep working) and reported to the `listenerError` listeners. A throwing
   * `listenerError` listener is swallowed, so the report never recurses.
   *
   * @param event - The lifecycle event name or CDP method name.
   * @param payload - The payload to deliver.
   */
  #emit(event: string, payload: unknown): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        (listener as (value: unknown) => void)(payload);
      } catch (error) {
        if (event !== LISTENER_ERROR_EVENT) {
          this.#emitListenerError(event, error);
        }
      }
    }
  }

  /**
   * Reports a throwing listener to the `listenerError` listeners.
   *
   * @param event - The event name whose listener threw.
   * @param error - The thrown value.
   */
  #emitListenerError(event: string, error: unknown): void {
    const listeners = this.#listeners.get(LISTENER_ERROR_EVENT);
    if (!listeners) {
      return;
    }
    const payload: HermesListenerErrorEvent = { event, error };
    for (const listener of [...listeners]) {
      try {
        (listener as (value: HermesListenerErrorEvent) => void)(payload);
      } catch {
        // A failing `listenerError` listener must not recurse or break the
        // socket handler.
      }
    }
  }
}

/**
 * Builds the failure result for a connect that was still in flight when the
 * client was closed.
 *
 * @returns A `HERMES_CONNECTION_FAILED` failure.
 */
function closedDuringConnectResult(): HermesFailureResult {
  return {
    ok: false,
    code: HERMES_CONNECTION_FAILED,
    message: `${CLIENT_CLOSED_MESSAGE} before the connection completed`,
  };
}

/**
 * Builds the failure result for a call made while the socket is not open.
 *
 * @returns A `HERMES_CONNECTION_FAILED` failure.
 */
function connectionNotOpenResult(): HermesCdpResult {
  return {
    ok: false,
    code: HERMES_CONNECTION_FAILED,
    message: 'Hermes CDP connection is not open',
  };
}

/**
 * Builds the failure result for an aborted call.
 *
 * @param method - The CDP method that was aborted.
 * @returns A `HERMES_ABORTED` failure.
 */
function abortedResult(method: string): HermesCdpResult {
  return {
    ok: false,
    code: HERMES_ABORTED,
    message: `Hermes CDP call "${method}" was aborted`,
  };
}

/**
 * Reads the execution context id from a `Runtime.executionContextCreated`
 * payload.
 *
 * @param params - The CDP event payload.
 * @returns The numeric context id, or undefined when absent.
 */
function readExecutionContextId(params: unknown): number | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const { context } = params as { context?: unknown };
  if (typeof context !== 'object' || context === null) {
    return undefined;
  }
  const { id } = context as { id?: unknown };
  return typeof id === 'number' ? id : undefined;
}

/**
 * Reads the close reason from a close event, tolerating a plain `Event`.
 *
 * @param event - The socket close event.
 * @returns The close reason, or `socket closed` when empty.
 */
function readCloseReason(event: Event): string {
  const { reason } = event as { reason?: unknown };
  return typeof reason === 'string' && reason.length > 0
    ? reason
    : 'socket closed';
}

/**
 * Unrefs a Node timer so an idle client never keeps the process alive.
 *
 * @param timer - The timer handle (a `NodeJS.Timeout` in Node).
 */
function unrefTimer(timer: unknown): void {
  if (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof (timer as { unref?: unknown }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref();
  }
}
