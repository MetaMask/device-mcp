import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HermesCdpResult } from './hermes-cdp.js';
import {
  HERMES_ABORTED,
  HERMES_BLOCKED_METHOD,
  HERMES_CDP_FAILED,
  HERMES_CONNECTION_FAILED,
  HERMES_TIMEOUT,
  HERMES_WEBSOCKET_UNAVAILABLE,
  IDENTITY_PROBE_EXPR,
} from './hermes-cdp.js';
import { HermesClient } from './hermes-client.js';
import type {
  HermesCdpEvent,
  HermesClientOptions,
  HermesContextCreatedEvent,
  HermesContextDestroyedEvent,
} from './hermes-client.js';

const APP_ID = 'io.metamask.MetaMask';
const METRO_PORT = 8085;
const SOCKET_URL = `ws://localhost:${METRO_PORT}/inspector/debug?device=device-1&page=1`;

type CdpRequest = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
};

type MockResponse = Record<string, unknown> | string | undefined;

class FakeWebSocket extends EventTarget {
  static readonly connecting = 0;

  static readonly openState = 1;

  static readonly closing = 2;

  static readonly closed = 3;

  static instances: FakeWebSocket[] = [];

  static autoOpen = true;

  static responseFactory: ((request: CdpRequest) => MockResponse) | undefined;

  readonly url: string;

  readonly options: { headers: { origin: string } } | undefined;

  readonly sent: CdpRequest[] = [];

  readyState = FakeWebSocket.connecting;

  constructor(url: string, options?: { headers: { origin: string } }) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);

    if (FakeWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  send(raw: string): void {
    const request = JSON.parse(raw) as CdpRequest;
    this.sent.push(request);
    const response = FakeWebSocket.responseFactory?.(request);
    if (response !== undefined) {
      const payload =
        typeof response === 'string' ? response : JSON.stringify(response);
      queueMicrotask(() => this.receive(payload));
    }
  }

  close(): void {
    if (this.readyState === FakeWebSocket.closed) {
      return;
    }
    this.readyState = FakeWebSocket.closed;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = FakeWebSocket.openState;
    this.dispatchEvent(new Event('open'));
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  /**
   * Simulates the app reloading or Metro restarting: the remote end drops the
   * socket without the client asking for it.
   *
   * @param reason - The close reason reported by the remote end.
   */
  drop(reason = ''): void {
    this.readyState = FakeWebSocket.closed;
    const event = new Event('close');
    Object.defineProperty(event, 'reason', { value: reason });
    this.dispatchEvent(event);
  }
}

Object.defineProperties(FakeWebSocket, {
  CONNECTING: { value: FakeWebSocket.connecting },
  OPEN: { value: FakeWebSocket.openState },
  CLOSING: { value: FakeWebSocket.closing },
  CLOSED: { value: FakeWebSocket.closed },
});

let fetchMock: ReturnType<typeof vi.fn>;

function target(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'device-page-1',
    title: 'io.metamask.MetaMask (iPhone 15)',
    appId: APP_ID,
    webSocketDebuggerUrl: SOCKET_URL,
    reactNative: {
      logicalDeviceId: 'logical-device-1',
      capabilities: { nativePageReloads: true },
    },
    ...overrides,
  };
}

function mockDiscovery(targets: unknown[]): void {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(targets),
  });
  vi.stubGlobal('fetch', fetchMock);
}

function isIdentityProbe(request: CdpRequest): boolean {
  return request.params?.expression === IDENTITY_PROBE_EXPR;
}

function probeResponse(request: CdpRequest): Record<string, unknown> {
  return {
    id: request.id,
    result: {
      result: {
        type: 'string',
        value: '{"isHermes":true,"ossVersion":"0.19.0","debuggerEnabled":true}',
      },
    },
  };
}

function defaultResponseFactory(request: CdpRequest): Record<string, unknown> {
  if (isIdentityProbe(request)) {
    return probeResponse(request);
  }
  return { id: request.id, result: { result: { type: 'number', value: 2 } } };
}

function isRuntimeEnable(request: CdpRequest): boolean {
  return request.method === 'Runtime.enable';
}

/**
 * Answers the identity probe and the client's internal `Runtime.enable`, but
 * leaves user methods unanswered.
 *
 * @param request - The sent CDP request.
 * @returns The mocked response, or undefined to stay pending.
 */
function controlOnly(request: CdpRequest): MockResponse {
  if (isIdentityProbe(request)) {
    return probeResponse(request);
  }
  if (isRuntimeEnable(request)) {
    return { id: request.id, result: {} };
  }
  return undefined;
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (!socket) {
    throw new Error(`Missing FakeWebSocket instance ${index}`);
  }
  return socket;
}

function createClient(
  overrides: Partial<HermesClientOptions> = {},
): HermesClient {
  return new HermesClient({
    metroPort: METRO_PORT,
    appId: APP_ID,
    ...overrides,
  });
}

function expectError(
  result: HermesCdpResult,
  code: string,
): asserts result is { ok: false; code: string; message: string } {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

/**
 * Lets every pending microtask (discovery, socket open, probe) settle.
 *
 * @returns A promise resolved after a macrotask.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Waits for a fixed duration.
 *
 * @param ms - Milliseconds to wait.
 * @returns A promise resolved after the delay.
 */
async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('HermesClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = true;
    FakeWebSocket.responseFactory = defaultResponseFactory;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    mockDiscovery([target()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('connects once and runs the identity probe once across many sends', async () => {
    const client = createClient();

    const first = await client.send(
      'Runtime.evaluate',
      { expression: '1+1', returnByValue: true },
      { timeoutMs: 1_000 },
    );
    const second = await client.send(
      'Runtime.evaluate',
      { expression: '2+2', returnByValue: true },
      { timeoutMs: 1_000 },
    );

    expect(first).toStrictEqual({
      ok: true,
      result: { result: { type: 'number', value: 2 } },
    });
    expect(second.ok).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const socket = socketAt(0);
    expect(socket.sent.map((request) => request.id)).toStrictEqual([
      1, 2, 3, 4,
    ]);
    expect(socket.sent.filter(isIdentityProbe)).toHaveLength(1);
    expect(socket.sent.filter(isRuntimeEnable)).toHaveLength(1);
    expect(socket.options?.headers.origin).toBe(
      `http://127.0.0.1:${METRO_PORT}`,
    );
    expect(client.isConnected).toBe(true);

    client.close();
  });

  it('shares one in-flight connect and emits contextCreated once', async () => {
    const client = createClient();
    const created = vi.fn();
    client.on('contextCreated', created);

    const [first, second] = await Promise.all([
      client.connect({ timeoutMs: 1_000 }),
      client.connect({ timeoutMs: 1_000 }),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toStrictEqual(first);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith({
      target: {
        id: 'device-page-1',
        logicalDeviceId: 'logical-device-1',
        title: 'io.metamask.MetaMask (iPhone 15)',
      },
      reconnected: false,
      reason: 'connect',
    });
  });

  it('sends Runtime.enable once per socket', async () => {
    const client = createClient();

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    const enableMessages = socketAt(0).sent.filter(isRuntimeEnable);
    expect(enableMessages).toStrictEqual([
      { id: 2, method: 'Runtime.enable', params: {} },
    ]);
  });

  it('does not send Runtime.enable when trackContexts is off', async () => {
    const client = createClient({ trackContexts: false });
    const created = vi.fn();
    client.on('contextCreated', created);

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    const socket = socketAt(0);

    expect(socket.sent.map((request) => request.id)).toStrictEqual([1, 2]);
    expect(socket.sent.filter(isRuntimeEnable)).toHaveLength(0);

    socket.receive(
      JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { name: 'main', id: 2 } },
      }),
    );
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('emits one contextDestroyed and one reload contextCreated when the app reloads on the same socket', async () => {
    const client = createClient();
    const created: HermesContextCreatedEvent[] = [];
    const destroyed: HermesContextDestroyedEvent[] = [];
    const raw: HermesCdpEvent[] = [];
    client.on('contextCreated', (event) => created.push(event));
    client.on('contextDestroyed', (event) => destroyed.push(event));
    client.on('Runtime.executionContextCreated', (event) => raw.push(event));

    await client.connect({ timeoutMs: 1_000 });
    const socket = socketAt(0);
    const expectedTarget = {
      id: 'device-page-1',
      logicalDeviceId: 'logical-device-1',
      title: 'io.metamask.MetaMask (iPhone 15)',
    };

    // The first context after Runtime.enable is the one connect already
    // reported, so it must not produce a second contextCreated.
    const firstContext = {
      method: 'Runtime.executionContextCreated',
      params: { context: { name: 'main', id: 2 } },
    };
    socket.receive(JSON.stringify(firstContext));
    expect(created).toStrictEqual([
      { target: expectedTarget, reconnected: false, reason: 'connect' },
    ]);
    // Raw CDP events still reach listeners.
    expect(raw).toStrictEqual([firstContext]);

    // Reload: Hermes sends both destroy events; they coalesce into one.
    socket.receive(
      JSON.stringify({
        method: 'Runtime.executionContextDestroyed',
        params: { executionContextId: 2 },
      }),
    );
    socket.receive(
      JSON.stringify({
        method: 'Runtime.executionContextsCleared',
        params: {},
      }),
    );
    expect(destroyed).toStrictEqual([{ reason: 'reload' }]);

    socket.receive(
      JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { name: 'main', id: 3 } },
      }),
    );
    expect(created).toHaveLength(2);
    expect(created[1]).toStrictEqual({
      target: expectedTarget,
      reconnected: false,
      reason: 'reload',
      executionContextId: 3,
    });
  });

  it('keeps the connection when Runtime.enable fails', async () => {
    FakeWebSocket.responseFactory = (request) => {
      if (isIdentityProbe(request)) {
        return probeResponse(request);
      }
      if (isRuntimeEnable(request)) {
        return {
          id: request.id,
          error: { message: 'Method not found', code: -32601 },
        };
      }
      return undefined;
    };
    const client = createClient();
    const created = vi.fn();
    client.on('contextCreated', created);

    const result = await client.connect({ timeoutMs: 1_000 });

    expect(result.ok).toBe(true);
    expect(client.isConnected).toBe(true);

    socketAt(0).receive(
      JSON.stringify({
        method: 'Runtime.executionContextCreated',
        params: { context: { name: 'main', id: 2 } },
      }),
    );
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'connect' }),
    );
  });

  it('returns the current target when already connected', async () => {
    const client = createClient();
    await client.connect({ timeoutMs: 1_000 });

    const again = await client.connect({ timeoutMs: 1_000 });

    expect(again.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('matches concurrent responses by id, even out of order', async () => {
    FakeWebSocket.responseFactory = controlOnly;
    const client = createClient();

    const first = client.send(
      'Runtime.evaluate',
      { expression: 'a' },
      { timeoutMs: 5_000 },
    );
    const second = client.send(
      'Runtime.evaluate',
      { expression: 'b' },
      { timeoutMs: 5_000 },
    );

    await flush();
    const socket = socketAt(0);
    expect(socket.sent).toHaveLength(4);

    socket.receive(JSON.stringify({ id: 4, result: 'b' }));
    socket.receive(JSON.stringify({ id: 3, result: 'a' }));

    expect(await second).toStrictEqual({ ok: true, result: 'b' });
    expect(await first).toStrictEqual({ ok: true, result: 'a' });
  });

  it('fails with HERMES_TIMEOUT on a per-call timeout and drops the pending entry', async () => {
    FakeWebSocket.responseFactory = controlOnly;
    const client = createClient();

    const result = await client.send(
      'Runtime.evaluate',
      { expression: 'never' },
      { timeoutMs: 30 },
    );

    expectError(result, HERMES_TIMEOUT);
    expect(result.message).toBe('Hermes CDP call timed out after 30ms');

    // The late response must be ignored, and the next call gets a fresh id.
    const socket = socketAt(0);
    socket.receive(JSON.stringify({ id: 3, result: 'late' }));
    FakeWebSocket.responseFactory = defaultResponseFactory;
    const next = await client.send(
      'Runtime.evaluate',
      {},
      { timeoutMs: 1_000 },
    );

    expect(next.ok).toBe(true);
    expect(socket.sent.map((request) => request.id)).toStrictEqual([
      1, 2, 3, 4,
    ]);
  });

  it('fails with HERMES_ABORTED when the signal aborts and drops the pending entry', async () => {
    FakeWebSocket.responseFactory = controlOnly;
    const controller = new AbortController();
    const client = createClient();

    const pending = client.send(
      'Runtime.evaluate',
      { expression: 'slow' },
      { timeoutMs: 5_000, signal: controller.signal },
    );
    await flush();
    controller.abort();

    const result = await pending;
    expectError(result, HERMES_ABORTED);
    expect(result.message).toContain('aborted');

    const socket = socketAt(0);
    socket.receive(JSON.stringify({ id: 3, result: 'late' }));
    FakeWebSocket.responseFactory = defaultResponseFactory;
    const next = await client.send(
      'Runtime.evaluate',
      {},
      { timeoutMs: 1_000 },
    );

    expect(next.ok).toBe(true);
    expect(socket.sent.map((request) => request.id)).toStrictEqual([
      1, 2, 3, 4,
    ]);
  });

  it('does not connect for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createClient();

    const result = await client.send('Runtime.evaluate', undefined, {
      timeoutMs: 1_000,
      signal: controller.signal,
    });

    expectError(result, HERMES_ABORTED);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('formats a CDP error into HERMES_CDP_FAILED', async () => {
    FakeWebSocket.responseFactory = (request) => {
      if (isIdentityProbe(request)) {
        return probeResponse(request);
      }
      if (isRuntimeEnable(request)) {
        return { id: request.id, result: {} };
      }
      return {
        id: request.id,
        error: {
          message: 'Bad params',
          code: -32602,
          data: { reason: 'invalid' },
        },
      };
    };
    const client = createClient();

    const result = await client.send('Missing.method', undefined, {
      timeoutMs: 1_000,
    });

    expectError(result, HERMES_CDP_FAILED);
    expect(result.message).toContain('"Missing.method"');
    expect(result.message).toContain('Bad params');
    expect(result.message).toContain('{"reason":"invalid"}');
  });

  it('dispatches CDP events to on() listeners and stops after off()', async () => {
    const client = createClient();
    const received: HermesCdpEvent[] = [];
    const listener = (event: HermesCdpEvent): void => {
      received.push(event);
    };
    client.on('Runtime.consoleAPICalled', listener);

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    const socket = socketAt(0);

    socket.receive(
      JSON.stringify({
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [] },
      }),
    );
    expect(received).toStrictEqual([
      {
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [] },
      },
    ]);

    client.off('Runtime.consoleAPICalled', listener);
    socket.receive(
      JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }),
    );
    expect(received).toHaveLength(1);
  });

  it('keeps dispatching when a listener throws', async () => {
    const client = createClient();
    const received: HermesCdpEvent[] = [];
    client.on('Runtime.consoleAPICalled', () => {
      throw new Error('listener failed');
    });
    client.on('Runtime.consoleAPICalled', (event: HermesCdpEvent) => {
      received.push(event);
    });

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    const socket = socketAt(0);
    socket.receive(
      JSON.stringify({ method: 'Runtime.consoleAPICalled', params: {} }),
    );

    expect(received).toHaveLength(1);
    const next = await client.send('Runtime.evaluate', undefined, {
      timeoutMs: 1_000,
    });
    expect(next.ok).toBe(true);
  });

  it('ignores malformed and unknown-id frames', async () => {
    const client = createClient();
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    const socket = socketAt(0);

    socket.receive('not json');
    socket.receive('42');
    socket.receive(JSON.stringify({ result: { ignored: true } }));
    socket.receive(JSON.stringify({ id: 999, result: 'unknown' }));

    const next = await client.send('Runtime.evaluate', undefined, {
      timeoutMs: 1_000,
    });
    expect(next.ok).toBe(true);
  });

  it('pins the device on first connect and does not call onPin again', async () => {
    const onPin = vi.fn();
    const client = createClient({ onPin });

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith('logical-device-1');
  });

  it('does not call onPin when a pin already exists', async () => {
    const onPin = vi.fn();
    const client = createClient({ pinnedDeviceId: 'logical-device-1', onPin });

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    expect(onPin).not.toHaveBeenCalled();
  });

  it('fails with HERMES_BLOCKED_METHOD without discovering or connecting', async () => {
    const client = createClient();

    const result = await client.send('Runtime.terminateExecution', undefined, {
      timeoutMs: 1_000,
    });

    expectError(result, HERMES_BLOCKED_METHOD);
    expect(result.message).toContain('Inspector.detached');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('fails with HERMES_WEBSOCKET_UNAVAILABLE without discovering', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const client = createClient();

    const result = await client.connect({ timeoutMs: 1_000 });

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_WEBSOCKET_UNAVAILABLE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates a discovery failure as HERMES_CONNECTION_FAILED', async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const client = createClient();

    const result = await client.connect({ timeoutMs: 1_000 });

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_CONNECTION_FAILED,
      message: expect.stringContaining('ECONNREFUSED'),
    });
    expect(client.isConnected).toBe(false);
  });

  it('closing fails pending calls and closes the socket', async () => {
    FakeWebSocket.responseFactory = controlOnly;
    const client = createClient();

    const pending = client.send('Runtime.evaluate', undefined, {
      timeoutMs: 5_000,
    });
    await flush();
    client.close();
    client.close();

    const result = await pending;
    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('HermesClient is closed');
    expect(socketAt(0).readyState).toBe(FakeWebSocket.closed);
    expect(client.isConnected).toBe(false);
  });

  it('reports the configured port and app id', () => {
    const client = createClient({ appId: 'io.metamask', metroPort: 9000 });

    expect(client.metroPort).toBe(9000);
    expect(client.appId).toBe('io.metamask');
  });

  it('reconnects after an unexpected close, rediscovers the target and emits contextCreated again', async () => {
    const client = createClient({
      reconnect: { initialDelayMs: 10, maxDelayMs: 40, maxAttempts: 3 },
    });
    const disconnected: { reason: string }[] = [];
    const reconnected: unknown[] = [];
    const created: unknown[] = [];
    client.on('disconnected', (event) => disconnected.push(event));
    client.on('reconnected', (event) => reconnected.push(event));
    client.on('contextCreated', (event) => created.push(event));

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    expect(created).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.responseFactory = controlOnly;
    const pending = client.send('Network.enable', undefined, {
      timeoutMs: 5_000,
    });
    await flush();
    expect(socketAt(0).sent).toHaveLength(4);

    // The app reloads: the target id and URL change behind the same Metro port.
    mockDiscovery([
      target({
        id: 'device-page-2',
        webSocketDebuggerUrl: `ws://localhost:${METRO_PORT}/inspector/debug?device=device-1&page=2`,
      }),
    ]);
    socketAt(0).drop('app reload');

    const pendingResult = await pending;
    expectError(pendingResult, HERMES_CONNECTION_FAILED);
    expect(pendingResult.message).toContain('app reload');
    expect(disconnected).toStrictEqual([{ reason: 'app reload' }]);
    expect(client.isConnected).toBe(false);

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    await vi.waitFor(() => expect(created).toHaveLength(2));

    expect(socketAt(1).url).toContain('page=2');
    // The reconnect re-ran discovery through the second fetch stub.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reconnected).toStrictEqual([
      {
        target: {
          id: 'device-page-2',
          logicalDeviceId: 'logical-device-1',
          title: 'io.metamask.MetaMask (iPhone 15)',
        },
        attempts: 1,
      },
    ]);
    expect(created[1]).toMatchObject({
      reconnected: true,
      reason: 'reconnect',
      target: { id: 'device-page-2' },
    });
    expect(client.isConnected).toBe(true);

    // eslint-disable-next-line require-atomic-updates -- test-double state, not shared across async work
    FakeWebSocket.responseFactory = defaultResponseFactory;
    const after = await client.send('Runtime.evaluate', undefined, {
      timeoutMs: 1_000,
    });
    expect(after.ok).toBe(true);
    expect(socketAt(1).sent.map((request) => request.id)).toStrictEqual([
      1, 2, 3,
    ]);
  });

  it('retries with backoff and gives up after maxAttempts', async () => {
    const client = createClient({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
    });
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    socketAt(0).drop('app reload');

    await delay(60);

    // Two attempts, then the client gives up (no socket was ever adopted).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });

  it('does not reconnect to a different device after a reload (pin mismatch)', async () => {
    const client = createClient({
      pinnedDeviceId: 'logical-device-1',
      reconnect: { initialDelayMs: 10, maxDelayMs: 40, maxAttempts: 3 },
    });
    const reconnected = vi.fn();
    const created = vi.fn();
    client.on('reconnected', reconnected);
    client.on('contextCreated', created);

    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    mockDiscovery([
      target({
        id: 'other-device',
        webSocketDebuggerUrl: `ws://localhost:${METRO_PORT}/inspector/debug?device=device-2&page=1`,
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
    ]);
    socketAt(0).drop('app reload');

    await delay(80);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.isConnected).toBe(false);
    expect(reconnected).not.toHaveBeenCalled();
    expect(created).toHaveBeenCalledTimes(1);
  });

  it('close() stops a scheduled reconnect', async () => {
    const client = createClient({
      reconnect: { initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 },
    });
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    socketAt(0).drop('app reload');
    client.close();

    await delay(80);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('connects again on the next send after the reconnect loop gave up', async () => {
    const client = createClient({
      reconnect: { initialDelayMs: 5, maxDelayMs: 10, maxAttempts: 1 },
    });
    await client.send('Runtime.evaluate', undefined, { timeoutMs: 1_000 });

    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    socketAt(0).drop('app reload');
    await delay(40);

    mockDiscovery([target({ id: 'device-page-3' })]);
    const result = await client.send('Runtime.evaluate', undefined, {
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socketAt(1).url).toBe(SOCKET_URL);
  });
});
