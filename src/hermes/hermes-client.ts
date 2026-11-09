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
 * When the app reloads (or Metro restarts) the socket closes. Pending calls are
 * failed with `HERMES_CONNECTION_FAILED` and NOT resent (they may have run), then
 * the client rediscovers the target (its id and URL change after a reload) and
 * reconnects with exponential backoff. Every successful (re)connect emits
 * `contextCreated` so callers can re-apply their scripts (page reloads reset the
 * runtime).
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

/** Connect timeout used by the automatic reconnect loop. */
const DEFAULT_RECONNECT_TIMEOUT_MS = 10_000;

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
 * Result of {@link HermesClient.connect}.
 */
export type HermesConnectResult =
  | { ok: true; target: HermesConnectedTarget }
  | { ok: false; code: string; message: string };

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
 * Payload of the `contextCreated` lifecycle event, emitted after every
 * successful connect (including the first one) and after every reconnect.
 */
export type HermesContextCreatedEvent = {
  /** The verified target of the new connection. */
  target: HermesConnectedTarget;
  /** True for a reconnect, false for the initial connect. */
  reconnected: boolean;
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
 * Lifecycle events with a typed payload. Any other event name is a CDP event
 * and receives a {@link HermesCdpEvent}.
 */
export type HermesClientEventMap = {
  contextCreated: HermesContextCreatedEvent;
  disconnected: HermesDisconnectedEvent;
  reconnected: HermesReconnectedEvent;
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
 */
export class HermesClient {
  readonly #metroPort: number;

  readonly #appId: string;

  readonly #origin: string | undefined;

  readonly #onPin: ((logicalDeviceId: string) => void) | undefined;

  readonly #reconnect: Required<HermesClientReconnectOptions>;

  readonly #listeners = new Map<string, Set<HermesEventListener>>();

  readonly #pending = new Map<number, PendingCall>();

  #pinnedDeviceId: string | undefined;

  #socket: WebSocket | undefined;

  #target: HermesConnectedTarget | undefined;

  #status: HermesClientStatus = 'idle';

  #nextId = 1;

  #inFlightConnect: Promise<HermesConnectResult> | undefined;

  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  #reconnectAttempt = 0;

  #connectTimeoutMs = DEFAULT_RECONNECT_TIMEOUT_MS;

  #explicitlyClosed = false;

  constructor(options: HermesClientOptions) {
    this.#metroPort = options.metroPort;
    this.#appId = options.appId;
    this.#origin = options.origin;
    this.#pinnedDeviceId = options.pinnedDeviceId;
    this.#onPin = options.onPin;
    this.#reconnect = {
      initialDelayMs:
        options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs:
        options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
      maxAttempts:
        options.reconnect?.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS,
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
   * socket, one identity probe). Emits `contextCreated` on success. A client
   * closed with {@link close} reopens.
   *
   * @param options - The connect timeout.
   * @returns The verified target or a classified failure.
   */
  async connect(options: HermesConnectOptions): Promise<HermesConnectResult> {
    const { timeoutMs } = options;
    this.#explicitlyClosed = false;
    this.#clearReconnectTimer();
    this.#reconnectAttempt = 0;
    this.#connectTimeoutMs = timeoutMs;

    if (this.isConnected && this.#target) {
      return { ok: true, target: this.#target };
    }

    return await this.#connectOnce(timeoutMs);
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
      const connected = await this.connect({ timeoutMs });
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
   * Lifecycle names are `contextCreated`, `disconnected` and `reconnected`.
   * Any other name receives the CDP event messages of that `method`
   * (for example `Runtime.consoleAPICalled`).
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
    this.#clearReconnectTimer();
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
  }

  /**
   * Shares one in-flight connect between concurrent callers and emits the
   * connect lifecycle events once.
   *
   * @param timeoutMs - The connect timeout.
   * @param reconnectAttempts - Set for a reconnect attempt, used for the
   * `reconnected` payload and to distinguish the reordered lifecycle events.
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

    const isReconnect = reconnectAttempts !== undefined;
    const promise = this.#doConnect(timeoutMs, isReconnect)
      .then((result) => {
        if (result.ok) {
          if (isReconnect) {
            this.#emit('reconnected', {
              target: result.target,
              attempts: reconnectAttempts,
            });
          }
          this.#emit('contextCreated', {
            target: result.target,
            reconnected: isReconnect,
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
   * @param reconnect - True for an automatic reconnect attempt.
   * @returns The verified target or a classified failure.
   */
  async #doConnect(
    timeoutMs: number,
    reconnect: boolean,
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

      const selection = selectHermesTarget(
        targets,
        this.#appId,
        this.#pinnedDeviceId,
      );
      if (!selection.ok) {
        const pinMismatch = this.#detectReconnectPinMismatch(
          targets,
          selection.code,
          reconnect,
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

      await waitForSocketOpen(connectingSocket, timeoutMs);

      // The probe runs once per socket, with id 1; user calls start at 2.
      const probe = await runIdentityProbe(connectingSocket, timeoutMs, 1);
      if (!probe.ok) {
        return { ok: false, code: probe.code, message: probe.message };
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
      if (this.#explicitlyClosed) {
        return {
          ok: false,
          code: HERMES_CONNECTION_FAILED,
          message: `${CLIENT_CLOSED_MESSAGE} before the connection completed`,
        };
      }

      this.#adopt(connectingSocket, timeoutMs);
      adopted = true;
      this.#status = 'open';

      const target: HermesConnectedTarget = {
        id: selection.target.id,
        logicalDeviceId: targetDeviceId,
        title: selection.target.title,
      };
      this.#target = target;
      return { ok: true, target };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: HERMES_CONNECTION_FAILED,
        message: `Hermes CDP connection failed: ${message}`,
      };
    } finally {
      if (!adopted) {
        this.#status = 'closed';
        if (socket) {
          closeSocket(socket);
        }
      }
    }
  }

  /**
   * Turns a pinned selection failure into `HERMES_DEVICE_PIN_MISMATCH` during a
   * reconnect when Metro reports a different device. Inspection only: no socket
   * is opened for the wrong device.
   *
   * @param targets - All discovered targets.
   * @param code - The selection failure code.
   * @param reconnect - True for an automatic reconnect attempt.
   * @returns The mismatch result, or undefined to keep the selection failure.
   */
  #detectReconnectPinMismatch(
    targets: Parameters<typeof selectHermesTarget>[0],
    code: string,
    reconnect: boolean,
  ): { ok: false; code: string; message: string } | undefined {
    const pinnedDeviceId = this.#pinnedDeviceId;
    if (!reconnect || !pinnedDeviceId || code !== HERMES_TARGET_NOT_FOUND) {
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
   * Adopts an open, verified socket: installs the dispatcher and resets the CDP
   * id sequence for the new connection.
   *
   * @param socket - The verified socket.
   * @param timeoutMs - The timeout to reuse for later reconnect attempts.
   */
  #adopt(socket: WebSocket, timeoutMs: number): void {
    this.#detachSocket();
    this.#socket = socket;
    this.#nextId = 2;
    this.#connectTimeoutMs = timeoutMs;
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
    }
  };

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
   * emits `disconnected` and starts the reconnect loop.
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
    closeSocket(socket);

    this.#failAllPending(
      HERMES_CONNECTION_FAILED,
      pendingMessage ?? `Hermes CDP connection closed: ${reason}`,
    );
    this.#emit('disconnected', { reason });

    if (!this.#explicitlyClosed) {
      this.#startReconnect();
    }
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
   * Runs one reconnect attempt. Failures schedule the next backoff step; a
   * device pin mismatch stops the loop so the wrong device is never used.
   */
  async #attemptReconnect(): Promise<void> {
    if (this.#explicitlyClosed) {
      return;
    }
    try {
      const result = await this.#connectOnce(
        this.#connectTimeoutMs,
        this.#reconnectAttempt,
      );
      if (this.#explicitlyClosed) {
        return;
      }
      if (result.ok) {
        this.#reconnectAttempt = 0;
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
      } catch {
        // A failing listener must not break the socket handler or the
        // other listeners.
      }
    }
  }
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
