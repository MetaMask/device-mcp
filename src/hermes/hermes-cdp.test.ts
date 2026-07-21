/* eslint-disable vitest/prefer-lowercase-title, vitest/expect-expect */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeVerifiedCdpCommand,
  fetchDiscoveryTargets,
  hasAmbiguousTarget,
  HERMES_BLOCKED_METHOD,
  HERMES_CDP_FAILED,
  HERMES_CONNECTION_FAILED,
  HERMES_DEVICE_PIN_MISMATCH,
  HERMES_INVALID_WS_URL,
  HERMES_MULTIPLE_DEVICES,
  HERMES_NOT_VERIFIED,
  HERMES_TARGET_NOT_FOUND,
  HERMES_TIMEOUT,
  HERMES_WEBSOCKET_UNAVAILABLE,
  IDENTITY_PROBE_EXPR,
  runHermesCdp,
  selectHermesTarget,
  validateWebSocketUrl,
} from './hermes-cdp.js';
import type { HermesTarget, RunHermesCdpInput } from './hermes-cdp.js';

const APP_ID = 'io.metamask.MetaMask';
const METRO_PORT = 8081;

type CdpRequest = { id: number; method: string; params?: unknown };
type MockResponse = Record<string, unknown> | string | undefined;

class MockWebSocket extends EventTarget {
  static readonly connecting = 0;

  static readonly openState = 1;

  static readonly closing = 2;

  static readonly closed = 3;

  static instances: MockWebSocket[] = [];

  static autoOpen = true;

  static openSynchronously = false;

  static responseFactory: ((request: CdpRequest) => MockResponse) | undefined;

  readonly url: string;

  readyState = MockWebSocket.connecting;

  sentMessages: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);

    if (MockWebSocket.openSynchronously) {
      this.open();
    } else if (MockWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  send(message: string): void {
    this.sentMessages.push(message);
    const request = JSON.parse(message) as CdpRequest;
    const response = MockWebSocket.responseFactory?.(request);
    if (response !== undefined) {
      const payload =
        typeof response === 'string' ? response : JSON.stringify(response);
      queueMicrotask(() => this.message(payload));
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.closed) {
      return;
    }
    this.readyState = MockWebSocket.closed;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = MockWebSocket.openState;
    this.dispatchEvent(new Event('open'));
  }

  message(data: string): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

Object.defineProperties(MockWebSocket, {
  CONNECTING: { value: MockWebSocket.connecting },
  OPEN: { value: MockWebSocket.openState },
  CLOSING: { value: MockWebSocket.closing },
  CLOSED: { value: MockWebSocket.closed },
});

let fetchMock: ReturnType<typeof vi.fn>;

function target(overrides: Record<string, unknown> = {}): HermesTarget {
  return {
    id: 'device-page-1',
    title: 'io.metamask.MetaMask (iPhone 15)',
    description: 'MetaMask Hermes VM',
    appId: APP_ID,
    webSocketDebuggerUrl:
      'ws://localhost:8081/inspector/debug?device=device-1&page=1',
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

function defaultResponseFactory(request: CdpRequest): Record<string, unknown> {
  if (request.id === 1) {
    return {
      id: request.id,
      result: {
        result: {
          type: 'string',
          value:
            '{"isHermes":true,"ossVersion":"0.19.0","debuggerEnabled":true}',
        },
      },
    };
  }
  return { id: request.id, result: { result: { type: 'number', value: 2 } } };
}

function socketAt(index: number): MockWebSocket {
  const socket = MockWebSocket.instances[index];
  if (!socket) {
    throw new Error(`Missing MockWebSocket instance ${index}`);
  }
  return socket;
}

function sentMessage(socket: MockWebSocket, index: number): CdpRequest {
  const raw = socket.sentMessages[index];
  if (!raw) {
    throw new Error(`Missing sent message ${index}`);
  }
  return JSON.parse(raw) as CdpRequest;
}

function baseInput(
  overrides: Partial<RunHermesCdpInput> = {},
): RunHermesCdpInput {
  return {
    method: 'Runtime.evaluate',
    params: { expression: '1+1', returnByValue: true },
    timeoutMs: 30_000,
    metroPort: METRO_PORT,
    appId: APP_ID,
    pinnedDeviceId: undefined,
    ...overrides,
  };
}

function expectError(
  result: Awaited<ReturnType<typeof runHermesCdp>>,
  code: string,
): asserts result is { ok: false; code: string; message: string } {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
  }
}

describe('runHermesCdp', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    MockWebSocket.openSynchronously = false;
    MockWebSocket.responseFactory = defaultResponseFactory;
    vi.stubGlobal('WebSocket', MockWebSocket);
    mockDiscovery([target()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('happy path: identity probe + Runtime.evaluate returns the value', async () => {
    const result = await runHermesCdp(baseInput());

    expect(result).toStrictEqual({
      ok: true,
      result: { result: { type: 'number', value: 2 } },
    });
    expect(sentMessage(socketAt(0), 0)).toMatchObject({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: IDENTITY_PROBE_EXPR, returnByValue: true },
    });
    expect(sentMessage(socketAt(0), 1)).toMatchObject({
      id: 2,
      method: 'Runtime.evaluate',
    });
  });

  it('selects only the strictly-matching appId target', async () => {
    mockDiscovery([
      target({
        id: 'evil',
        appId: 'io.other.app',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?evil',
      }),
      target({
        id: 'good',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?good',
      }),
    ]);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?good');
  });

  it('appId mismatch → HERMES_TARGET_NOT_FOUND', async () => {
    mockDiscovery([target({ appId: 'io.evil.app' })]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_TARGET_NOT_FOUND);
    expect(result.message).toContain('Saw appIds: ["io.evil.app"]');
  });

  it('empty target list → HERMES_TARGET_NOT_FOUND', async () => {
    mockDiscovery([]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_TARGET_NOT_FOUND);
    expect(result.message).toContain('Saw appIds: []');
  });

  it('synthetic-title target is filtered out → HERMES_TARGET_NOT_FOUND', async () => {
    mockDiscovery([
      target({ title: 'React Native Experimental (Improved Chrome Reloads)' }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_TARGET_NOT_FOUND);
  });

  it('multi-device without pin → HERMES_MULTIPLE_DEVICES', async () => {
    mockDiscovery([
      target({
        id: 'first',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?first',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'second',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?second',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_MULTIPLE_DEVICES);
    expect(result.message).toContain('logical-device-1');
    expect(result.message).toContain('logical-device-2');
    expect(result.message).toContain('first');
    expect(result.message).toContain('second');
  });

  it('candidate missing logicalDeviceId among many → HERMES_MULTIPLE_DEVICES', async () => {
    mockDiscovery([
      target({
        id: 'has-device',
        webSocketDebuggerUrl: 'ws://localhost:8081/has-device',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'no-device',
        webSocketDebuggerUrl: 'ws://localhost:8081/no-device',
        reactNative: { capabilities: { nativePageReloads: true } },
      }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_MULTIPLE_DEVICES);
    expect(result.message).toContain('<missing>');
  });

  it('pins device on first successful call via onPin', async () => {
    const onPin = vi.fn();

    const result = await runHermesCdp(baseInput({ onPin }));

    expect(result.ok).toBe(true);
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledWith('logical-device-1');
  });

  it('does not call onPin when a pin already exists', async () => {
    const onPin = vi.fn();

    const result = await runHermesCdp(
      baseInput({ pinnedDeviceId: 'logical-device-1', onPin }),
    );

    expect(result.ok).toBe(true);
    expect(onPin).not.toHaveBeenCalled();
  });

  it('pin filter selects the same-device target on later calls', async () => {
    mockDiscovery([
      target({
        id: 'different-pin',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?different',
        reactNative: {
          logicalDeviceId: 'logical-device-2',
          capabilities: { nativePageReloads: true },
        },
      }),
      target({
        id: 'same-pin',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?same',
      }),
    ]);

    const result = await runHermesCdp(
      baseInput({ pinnedDeviceId: 'logical-device-1' }),
    );

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?same');
  });

  it('pin filtering away a mismatched-device target → HERMES_TARGET_NOT_FOUND', async () => {
    mockDiscovery([
      target({
        reactNative: { logicalDeviceId: 'logical-device-2', capabilities: {} },
      }),
    ]);

    const result = await runHermesCdp(
      baseInput({ pinnedDeviceId: 'logical-device-1' }),
    );

    expectError(result, HERMES_TARGET_NOT_FOUND);
  });

  it('nativePageReloads tiebreak selects the fresh same-device page', async () => {
    mockDiscovery([
      target({
        id: 'stale-page',
        webSocketDebuggerUrl: 'ws://localhost:8081/stale',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: false },
        },
      }),
      target({
        id: 'fresh-page',
        webSocketDebuggerUrl: 'ws://localhost:8081/fresh',
        reactNative: {
          logicalDeviceId: 'logical-device-1',
          capabilities: { nativePageReloads: true },
        },
      }),
    ]);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/fresh');
  });

  it('same-device duplicates resolve via last-in-array tiebreak', async () => {
    mockDiscovery([
      target({ id: 'page-1' }),
      target({
        id: 'page-2',
        webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?page=2',
      }),
    ]);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe('ws://localhost:8081/inspector/debug?page=2');
  });

  it('blocked method Runtime.terminateExecution → HERMES_BLOCKED_METHOD without a socket', async () => {
    const result = await runHermesCdp(
      baseInput({ method: 'Runtime.terminateExecution' }),
    );

    expectError(result, HERMES_BLOCKED_METHOD);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('blocked method Inspector.detached → HERMES_BLOCKED_METHOD without a socket', async () => {
    const result = await runHermesCdp(
      baseInput({ method: 'Inspector.detached' }),
    );

    expectError(result, HERMES_BLOCKED_METHOD);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('bad WS protocol (wss:) → HERMES_INVALID_WS_URL', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'wss://localhost:8081/inspector/debug' }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_INVALID_WS_URL);
    expect(result.message).toContain("Unexpected protocol 'wss:'");
  });

  it('bad WS protocol (http:) → HERMES_INVALID_WS_URL', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'http://localhost:8081/inspector/debug' }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_INVALID_WS_URL);
    expect(result.message).toContain("Unexpected protocol 'http:'");
  });

  it('bad WS host → HERMES_INVALID_WS_URL', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'ws://evil.com:8081/inspector' }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_INVALID_WS_URL);
    expect(result.message).toContain("Unexpected hostname 'evil.com'");
  });

  it('wrong WS port → HERMES_INVALID_WS_URL', async () => {
    mockDiscovery([
      target({ webSocketDebuggerUrl: 'ws://localhost:9999/inspector' }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_INVALID_WS_URL);
    expect(result.message).toContain(
      'Port mismatch: target=9999 expected=8081',
    );
  });

  it('malformed WS URL → HERMES_INVALID_WS_URL', async () => {
    mockDiscovery([target({ webSocketDebuggerUrl: 'not a valid url' })]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_INVALID_WS_URL);
    expect(result.message).toContain('not a valid URL');
  });

  it('discovery /json failure falls back to /json/list', async () => {
    fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([target()]),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8081/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8081/json/list',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('discovery /json throwing falls back to /json/list', async () => {
    fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([target()]),
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Metro down (ECONNREFUSED) → HERMES_CONNECTION_FAILED', async () => {
    fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('ECONNREFUSED');
  });

  it('non-array discovery payload → HERMES_CONNECTION_FAILED', async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ not: 'an array' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('non-array');
  });

  it('identity probe returns isHermes:false → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            result: { result: { value: '{"isHermes":false}' } },
          }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
  });

  it('identity probe CDP-level error → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            error: { message: 'Method not found', code: -32601 },
          }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('Method not found');
  });

  it('identity probe subtype error → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? {
            id: request.id,
            result: { result: { subtype: 'error', value: 'EvalError' } },
          }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('error subtype');
  });

  it('identity probe non-JSON value → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: '[object Object]' } } }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('non-JSON');
  });

  it('identity probe missing result.value → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: {} } }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('missing result.value');
  });

  it('identity probe null outer result → HERMES_NOT_VERIFIED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: null }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('missing result.value');
  });

  it('accepts an object-valued probe payload that verifies Hermes', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 1
        ? { id: request.id, result: { result: { value: { isHermes: true } } } }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
  });

  it('target missing logicalDeviceId after probe → HERMES_NOT_VERIFIED', async () => {
    mockDiscovery([
      target({ reactNative: { capabilities: { nativePageReloads: true } } }),
    ]);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_NOT_VERIFIED);
    expect(result.message).toContain('logicalDeviceId');
  });

  it('user method returns a CDP error → HERMES_CDP_FAILED', async () => {
    MockWebSocket.responseFactory = (request) =>
      request.id === 2
        ? {
            id: request.id,
            error: {
              message: 'Bad params',
              code: -32602,
              data: { reason: 'invalid' },
            },
          }
        : defaultResponseFactory(request);

    const result = await runHermesCdp(baseInput({ method: 'Missing.method' }));

    expectError(result, HERMES_CDP_FAILED);
    expect(result.message).toContain('Bad params');
    expect(result.message).toContain('{"reason":"invalid"}');
  });

  it('identity probe timeout → HERMES_TIMEOUT', async () => {
    vi.useFakeTimers();
    MockWebSocket.responseFactory = (request) =>
      request.id === 1 ? undefined : defaultResponseFactory(request);

    const resultPromise = runHermesCdp(baseInput({ timeoutMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expectError(result, HERMES_TIMEOUT);
    expect(result.message).toContain('timed out');
  });

  it('user-method timeout → HERMES_CONNECTION_FAILED via finally close', async () => {
    vi.useFakeTimers();
    MockWebSocket.responseFactory = (request) =>
      request.id === 1 ? defaultResponseFactory(request) : undefined;

    const resultPromise = runHermesCdp(baseInput({ timeoutMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(socketAt(0).readyState).toBe(MockWebSocket.closed);
  });

  it('WebSocket open timeout → HERMES_CONNECTION_FAILED', async () => {
    vi.useFakeTimers();
    MockWebSocket.autoOpen = false;

    const resultPromise = runHermesCdp(baseInput({ timeoutMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('connection timed out');
  });

  it('WebSocket error during open → HERMES_CONNECTION_FAILED', async () => {
    MockWebSocket.autoOpen = false;

    const resultPromise = runHermesCdp(baseInput());

    // Flush microtasks until discovery completes and the WebSocket is created.
    while (MockWebSocket.instances.length === 0) {
      await Promise.resolve();
    }
    socketAt(0).dispatchEvent(new Event('error'));
    const result = await resultPromise;

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('connection error');
  });

  it('socket closes before user method response → HERMES_CONNECTION_FAILED', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).close());
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(socketAt(0).readyState).toBe(MockWebSocket.closed);
  });

  it('WebSocket error while awaiting CDP response → HERMES_CONNECTION_FAILED', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).dispatchEvent(new Event('error')));
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('message error');
  });

  it('non-text WebSocket frame → HERMES_CONNECTION_FAILED', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).dispatchEvent(
            new MessageEvent('message', { data: { id: 2 } }),
          ),
        );
        return undefined;
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_CONNECTION_FAILED);
    expect(result.message).toContain('non-text');
  });

  it('WebSocket open path resolves immediately when already open', async () => {
    MockWebSocket.openSynchronously = true;

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
  });

  it('ignores unrelated response ids while awaiting the user method', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).message(JSON.stringify({ id: 999, result: {} })),
        );
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
  });

  it('ignores frames without numeric ids while awaiting the user method', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() =>
          socketAt(0).message(JSON.stringify({ result: { ignored: true } })),
        );
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
  });

  it('ignores non-object JSON frames while awaiting the user method', async () => {
    MockWebSocket.responseFactory = (request) => {
      if (request.id === 2) {
        queueMicrotask(() => socketAt(0).message('42'));
      }
      return defaultResponseFactory(request);
    };

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
  });

  it('filters malformed discovery entries while keeping valid targets', async () => {
    mockDiscovery([
      null,
      'not an object',
      { appId: 123, webSocketDebuggerUrl: 'ws://localhost:8081/bad' },
      target(),
    ]);

    const result = await runHermesCdp(baseInput());

    expect(result.ok).toBe(true);
    expect(socketAt(0).url).toBe(
      'ws://localhost:8081/inspector/debug?device=device-1&page=1',
    );
  });

  it('global WebSocket unavailable → HERMES_WEBSOCKET_UNAVAILABLE without fetch', async () => {
    vi.stubGlobal('WebSocket', undefined);

    const result = await runHermesCdp(baseInput());

    expectError(result, HERMES_WEBSOCKET_UNAVAILABLE);
    expect(result.message).toContain('Global WebSocket is unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('selectHermesTarget', () => {
  it('returns HERMES_TARGET_NOT_FOUND when no appId matches', () => {
    const selection = selectHermesTarget(
      [target({ appId: 'io.other' })],
      APP_ID,
      undefined,
    );
    expect(selection).toMatchObject({
      ok: false,
      code: HERMES_TARGET_NOT_FOUND,
    });
  });

  it('drops targets without a webSocketDebuggerUrl', () => {
    const selection = selectHermesTarget(
      [target({ webSocketDebuggerUrl: undefined })],
      APP_ID,
      undefined,
    );
    expect(selection.ok).toBe(false);
  });

  it('returns the matching target on success', () => {
    const selection = selectHermesTarget([target()], APP_ID, undefined);
    expect(selection).toMatchObject({
      ok: true,
      target: { id: 'device-page-1' },
    });
  });

  it('returns HERMES_MULTIPLE_DEVICES on distinct device ids', () => {
    const selection = selectHermesTarget(
      [
        target({
          id: 'a',
          reactNative: { logicalDeviceId: 'd1', capabilities: {} },
        }),
        target({
          id: 'b',
          webSocketDebuggerUrl: 'ws://localhost:8081/b',
          reactNative: { logicalDeviceId: 'd2', capabilities: {} },
        }),
      ],
      APP_ID,
      undefined,
    );
    expect(selection).toMatchObject({
      ok: false,
      code: HERMES_MULTIPLE_DEVICES,
    });
  });
});

describe('hasAmbiguousTarget', () => {
  it('is false for zero or one candidate', () => {
    expect(hasAmbiguousTarget([])).toBe(false);
    expect(hasAmbiguousTarget([target()])).toBe(false);
  });

  it('is true when a candidate is missing logicalDeviceId', () => {
    expect(
      hasAmbiguousTarget([
        target(),
        target({ reactNative: { capabilities: {} } }),
      ]),
    ).toBe(true);
  });

  it('is true for multiple distinct logical device ids', () => {
    expect(
      hasAmbiguousTarget([
        target({ reactNative: { logicalDeviceId: 'd1', capabilities: {} } }),
        target({ reactNative: { logicalDeviceId: 'd2', capabilities: {} } }),
      ]),
    ).toBe(true);
  });

  it('is false when all candidates share one logical device id', () => {
    expect(
      hasAmbiguousTarget([
        target({ reactNative: { logicalDeviceId: 'd1', capabilities: {} } }),
        target({ reactNative: { logicalDeviceId: 'd1', capabilities: {} } }),
      ]),
    ).toBe(false);
  });
});

describe('validateWebSocketUrl', () => {
  it('accepts a valid loopback ws URL on the expected port', () => {
    expect(
      validateWebSocketUrl('ws://localhost:8081/inspector', 8081),
    ).toStrictEqual({ ok: true });
    expect(
      validateWebSocketUrl('ws://127.0.0.1:8081/inspector', 8081),
    ).toStrictEqual({ ok: true });
  });

  it('rejects a missing URL', () => {
    const result = validateWebSocketUrl(undefined, 8081);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('missing'),
    });
  });

  it('rejects an unparseable URL', () => {
    const result = validateWebSocketUrl('::::', 8081);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ws protocol', () => {
    const result = validateWebSocketUrl('wss://localhost:8081/x', 8081);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unexpected protocol 'wss:'"),
    });
  });

  it('rejects a non-loopback hostname', () => {
    const result = validateWebSocketUrl('ws://evil.com:8081/x', 8081);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("Unexpected hostname 'evil.com'"),
    });
  });

  it('rejects a port mismatch', () => {
    const result = validateWebSocketUrl('ws://localhost:9999/x', 8081);
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('Port mismatch'),
    });
  });
});

describe('fetchDiscoveryTargets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns objects from the /json payload, filtering non-objects', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([null, 'x', target()]),
    });
    vi.stubGlobal('fetch', fetchFn);

    const targets = await fetchDiscoveryTargets(8081, 1_000);

    expect(targets).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:8081/json',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('throws the last error when all discovery paths fail', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchFn);

    await expect(fetchDiscoveryTargets(8081, 1_000)).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws on an HTTP error status across both paths', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchFn);

    await expect(fetchDiscoveryTargets(8081, 1_000)).rejects.toThrow(
      'HTTP 500',
    );
  });
});

describe('executeVerifiedCdpCommand', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    MockWebSocket.openSynchronously = false;
    MockWebSocket.responseFactory = defaultResponseFactory;
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('fails with HERMES_INVALID_WS_URL when the target lacks a ws URL', async () => {
    const result = await executeVerifiedCdpCommand(
      target({ webSocketDebuggerUrl: undefined }),
      baseInput(),
      undefined,
      undefined,
    );

    expect(result).toMatchObject({ ok: false, code: HERMES_INVALID_WS_URL });
  });

  it('fails with HERMES_WEBSOCKET_UNAVAILABLE when WebSocket is missing', async () => {
    vi.stubGlobal('WebSocket', undefined);

    const result = await executeVerifiedCdpCommand(
      target(),
      baseInput(),
      undefined,
      undefined,
    );

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_WEBSOCKET_UNAVAILABLE,
    });
  });

  it('returns the CDP result and pins via onPin on success', async () => {
    const onPin = vi.fn();

    const result = await executeVerifiedCdpCommand(
      target(),
      baseInput(),
      undefined,
      onPin,
    );

    expect(result.ok).toBe(true);
    expect(onPin).toHaveBeenCalledWith('logical-device-1');
  });

  it('fails closed with HERMES_DEVICE_PIN_MISMATCH', async () => {
    const result = await executeVerifiedCdpCommand(
      target(),
      baseInput({ pinnedDeviceId: 'other-device' }),
      'other-device',
      undefined,
    );

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_DEVICE_PIN_MISMATCH,
      message: expect.stringContaining('does not match session pin'),
    });
  });
});
