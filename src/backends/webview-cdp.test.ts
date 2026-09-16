import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchWebViewTargets,
  runWebViewCdp,
  selectWebViewTarget,
  validateWebViewWebSocketUrl,
  WEBVIEW_BLOCKED_METHOD,
  WEBVIEW_CDP_FAILED,
  WEBVIEW_INVALID_WS_URL,
  WEBVIEW_TARGET_NOT_FOUND,
  WEBVIEW_TIMEOUT,
  WEBVIEW_WEBSOCKET_UNAVAILABLE,
} from './webview-cdp.js';
import type { WebViewTarget } from './webview-cdp.js';

function page(overrides: Record<string, unknown> = {}): WebViewTarget {
  return {
    id: 'PAGE1',
    type: 'page',
    title: 'E2E Test Dapp',
    url: 'https://metamask.github.io/test-dapp/',
    webSocketDebuggerUrl: 'ws://localhost:9333/devtools/page/PAGE1',
    ...overrides,
  };
}

function assertOk<Res extends { ok: boolean }>(
  value: Res,
): asserts value is Extract<Res, { ok: true }> {
  expect(value.ok).toBe(true);
}

function assertErr<Res extends { ok: boolean }>(
  value: Res,
): asserts value is Extract<Res, { ok: false }> {
  expect(value.ok).toBe(false);
}

describe('selectWebViewTarget', () => {
  it('selects the first interactable page target', () => {
    const selection = selectWebViewTarget([page()], undefined);
    assertOk(selection);
    expect(selection.target.id).toBe('PAGE1');
  });

  it('skips about:blank shells', () => {
    const selection = selectWebViewTarget(
      [
        page({ id: 'BLANK', url: 'about:blank' }),
        page({ id: 'REAL', url: 'https://example.com' }),
      ],
      undefined,
    );
    assertOk(selection);
    expect(selection.target.id).toBe('REAL');
  });

  it('skips targets that are not pages', () => {
    const selection = selectWebViewTarget(
      [
        page({ id: 'SW', type: 'service_worker' }),
        page({ id: 'REAL', type: 'page' }),
      ],
      undefined,
    );
    assertOk(selection);
    expect(selection.target.id).toBe('REAL');
  });

  it('skips targets without a webSocketDebuggerUrl', () => {
    const selection = selectWebViewTarget(
      [
        page({ id: 'NOWS', webSocketDebuggerUrl: undefined }),
        page({ id: 'REAL' }),
      ],
      undefined,
    );
    assertOk(selection);
    expect(selection.target.id).toBe('REAL');
  });

  it('applies a urlFilter substring', () => {
    const selection = selectWebViewTarget(
      [
        page({ id: 'A', url: 'https://foo.example/app' }),
        page({ id: 'B', url: 'https://bar.example/app' }),
      ],
      'bar.example',
    );
    assertOk(selection);
    expect(selection.target.id).toBe('B');
  });

  it('fails closed when no page matches', () => {
    const selection = selectWebViewTarget([], undefined);
    assertErr(selection);
    expect(selection.code).toBe(WEBVIEW_TARGET_NOT_FOUND);
  });

  it('reports the urlFilter in the not-found message', () => {
    const selection = selectWebViewTarget([page()], 'no-such-url');
    assertErr(selection);
    expect(selection.message).toContain('no-such-url');
  });
});

describe('validateWebViewWebSocketUrl', () => {
  it('accepts a loopback ws URL on the expected port', () => {
    expect(
      validateWebViewWebSocketUrl(
        'ws://localhost:9333/devtools/page/PAGE1',
        9333,
      ),
    ).toStrictEqual({ ok: true });
  });

  it('rejects a missing URL', () => {
    const result = validateWebViewWebSocketUrl(undefined, 9333);
    expect(result.ok).toBe(false);
  });

  it('rejects a non-ws protocol', () => {
    const result = validateWebViewWebSocketUrl('http://localhost:9333/x', 9333);
    assertErr(result);
    expect(result.message).toContain('protocol');
  });

  it('rejects a non-loopback hostname', () => {
    const result = validateWebViewWebSocketUrl('ws://10.0.0.5:9333/x', 9333);
    assertErr(result);
    expect(result.message).toContain('hostname');
  });

  it('rejects a port mismatch', () => {
    const result = validateWebViewWebSocketUrl('ws://localhost:9999/x', 9333);
    assertErr(result);
    expect(result.message).toContain('mismatch');
  });
});

describe('fetchWebViewTargets', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns page targets from /json/list', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [page()],
    });

    const targets = await fetchWebViewTargets(9333, 5000);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe('PAGE1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:9333/json/list');
  });

  it('filters out non-object entries', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => [page(), null, 42, 'x'],
    });

    const targets = await fetchWebViewTargets(9333, 5000);

    expect(targets).toHaveLength(1);
  });

  it('falls back to /json when /json/list fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, json: async () => [page()] });

    const targets = await fetchWebViewTargets(9333, 5000);

    expect(targets).toHaveLength(1);
    expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:9333/json');
  });

  it('throws when all discovery paths fail', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(fetchWebViewTargets(9333, 5000)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

class FakeSocket {
  static instances: FakeSocket[] = [];

  static readonly connecting = 0;

  static readonly openState = 1;

  static readonly closing = 2;

  static readonly closed = 3;

  readonly url: string;

  readyState = FakeSocket.connecting;

  sent: string[] = [];

  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(handler);
    this.#listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    this.#listeners.set(
      type,
      list.filter((registered) => registered !== handler),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.closed;
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.#listeners.get(type) ?? []) {
      handler(event);
    }
  }

  open(): void {
    this.readyState = FakeSocket.openState;
    this.emit('open', {});
  }

  reply(response: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(response) });
  }
}

Object.defineProperties(FakeSocket, {
  CONNECTING: { value: FakeSocket.connecting },
  OPEN: { value: FakeSocket.openState },
  CLOSING: { value: FakeSocket.closing },
  CLOSED: { value: FakeSocket.closed },
});

describe('runWebViewCdp', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeSocket);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => [page()] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks destructive methods without opening a socket', async () => {
    const result = await runWebViewCdp({
      method: 'Browser.close',
      timeoutMs: 5000,
      localPort: 9333,
    });

    assertErr(result);
    expect(result.code).toBe(WEBVIEW_BLOCKED_METHOD);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('returns WEBSOCKET_UNAVAILABLE when WebSocket is missing', async () => {
    vi.stubGlobal('WebSocket', undefined);

    const result = await runWebViewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
      localPort: 9333,
    });

    assertErr(result);
    expect(result.code).toBe(WEBVIEW_WEBSOCKET_UNAVAILABLE);
  });

  it('sends the user method and returns the raw CDP result', async () => {
    const promise = runWebViewCdp({
      method: 'Runtime.evaluate',
      params: { expression: "document.querySelector('#x').click()" },
      timeoutMs: 5000,
      localPort: 9333,
    });

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply({ id: 1, result: { result: { value: 'ok' } } });

    const result = await promise;
    assertOk(result);
    expect(result.result).toStrictEqual({ result: { value: 'ok' } });
    const sent = JSON.parse(socket.sent[0]);
    expect(sent.method).toBe('Runtime.evaluate');
    expect(socket.readyState).toBe(FakeSocket.closed);
  });

  it('maps a CDP-level error to WEBVIEW_CDP_FAILED', async () => {
    const promise = runWebViewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
      localPort: 9333,
    });

    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply({ id: 1, error: { message: 'boom', code: -32000 } });

    const result = await promise;
    assertErr(result);
    expect(result.code).toBe(WEBVIEW_CDP_FAILED);
    expect(result.message).toContain('boom');
  });

  it('returns TARGET_NOT_FOUND when discovery yields no page', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });

    const result = await runWebViewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
      localPort: 9333,
    });

    assertErr(result);
    expect(result.code).toBe(WEBVIEW_TARGET_NOT_FOUND);
  });

  it('returns INVALID_WS_URL when the target ws port mismatches', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        page({ webSocketDebuggerUrl: 'ws://localhost:1111/x' }),
      ],
    });

    const result = await runWebViewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
      localPort: 9333,
    });

    assertErr(result);
    expect(result.code).toBe(WEBVIEW_INVALID_WS_URL);
  });

  it('maps a round-trip timeout to WEBVIEW_TIMEOUT', async () => {
    vi.useFakeTimers();
    try {
      const promise = runWebViewCdp({
        method: 'Runtime.evaluate',
        timeoutMs: 1000,
        localPort: 9333,
      });

      await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
      const socket = FakeSocket.instances[0];
      socket.open();
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(1001);

      const result = await promise;
      assertErr(result);
      expect(result.code).toBe(WEBVIEW_TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });
});
