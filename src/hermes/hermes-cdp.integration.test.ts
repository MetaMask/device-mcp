import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HERMES_CONNECTION_FAILED, runHermesCdp } from './hermes-cdp.js';

// Record the native client's headers, then deliberately reject every upgrade.
// The expected connection failure avoids simulating Hermes or WebSocket frames.
async function startHandshakeRecorder() {
  const server = createServer();
  const origins: (string | undefined)[] = [];
  const sockets = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    origins.push(request.headers.origin);
    socketClosures.push(
      new Promise<void>((resolve) => socket.once('close', resolve)),
    );
    socket.end(
      'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    origins,
    webSocketUrl: `ws://127.0.0.1:${port}/inspector/debug`,
    waitForSocketClosures: async () => Promise.all(socketClosures),
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

// Node 20 needs NODE_OPTIONS="--experimental-websocket" for these wire tests.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature-detect the experimental Node 20 API.
const hasWebSocket = typeof WebSocket === 'function';
describe.skipIf(!hasWebSocket)('hermes CDP outbound Origin', () => {
  let recorder: Awaited<ReturnType<typeof startHandshakeRecorder>> | undefined;

  beforeEach(async () => {
    recorder = await startHandshakeRecorder();
    // Discovery is unchanged and has its own unit tests. Keep WebSocket native.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          {
            appId: 'io.metamask.MetaMask',
            webSocketDebuggerUrl: recorder!.webSocketUrl,
            reactNative: { logicalDeviceId: 'device-1' },
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    const activeRecorder = recorder;
    recorder = undefined;
    try {
      await activeRecorder?.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the Expo-compatible default Origin in the native handshake', async () => {
    const onPin = vi.fn();
    const result = await runHermesCdp({
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      appId: 'io.metamask.MetaMask',
      metroPort: recorder!.port,
      timeoutMs: 2_000,
      onPin,
    });

    expect(result).toMatchObject({ ok: false, code: HERMES_CONNECTION_FAILED });
    // Node's client may retry a 401. Check every attempt, without fixing a count.
    expect(recorder!.origins.length).toBeGreaterThan(0);
    expect(new Set(recorder!.origins)).toStrictEqual(
      new Set([`http://127.0.0.1:${recorder!.port}`]),
    );
    expect(onPin).not.toHaveBeenCalled();
    await recorder!.waitForSocketClosures();
  });

  it('sends the explicit Origin while connecting to the local inspector', async () => {
    const origin = 'http://metro.example:9000';
    const onPin = vi.fn();
    const result = await runHermesCdp({
      method: 'Runtime.evaluate',
      params: { expression: '1+1' },
      appId: 'io.metamask.MetaMask',
      metroPort: recorder!.port,
      timeoutMs: 2_000,
      origin,
      onPin,
    });

    expect(result).toMatchObject({ ok: false, code: HERMES_CONNECTION_FAILED });
    expect(recorder!.origins.length).toBeGreaterThan(0);
    expect(new Set(recorder!.origins)).toStrictEqual(new Set([origin]));
    expect(onPin).not.toHaveBeenCalled();
    await recorder!.waitForSocketClosures();
  });
});
