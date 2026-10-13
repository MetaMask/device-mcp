/* eslint-disable no-bitwise -- WebSocket frame opcodes and masking are bitwise operations. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HERMES_CDP_FAILED,
  HERMES_CONNECTION_FAILED,
  HERMES_TIMEOUT,
  IDENTITY_PROBE_EXPR,
  runHermesCdp,
} from './hermes-cdp.js';
import type { RunHermesCdpInput } from './hermes-cdp.js';

type CdpRequest = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};

// A small real inspector: HTTP discovery, Origin gate, and CDP text frames.
async function startInspector(
  options: {
    hostname?: string;
    originHostname?: string;
    response?: (request: CdpRequest, socket: Duplex) => unknown;
    stallHandshake?: boolean;
  } = {},
) {
  const hostname = options.hostname ?? 'localhost';
  const origins: (string | undefined)[] = [];
  const requests: CdpRequest[] = [];
  const connections = new Set<Socket>();
  const socketClosures: Promise<void>[] = [];
  let port = 0;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify([
        {
          id: 'page-1',
          appId: 'io.metamask.MetaMask',
          webSocketDebuggerUrl: `ws://${hostname}:${port}/inspector/debug?device=device-1&page=1`,
          reactNative: { logicalDeviceId: 'device-1' },
        },
      ]),
    );
  });
  // Serve both localhost DNS families without requiring IPv6 on IPv4-only hosts.
  const ipv6Server = createServer();
  ipv6Server.on('request', (request, response) =>
    server.emit('request', request, response),
  );
  ipv6Server.on('upgrade', (request, socket, head) =>
    server.emit('upgrade', request, socket, head),
  );
  const trackConnection = (socket: Socket): void => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  };
  server.on('connection', trackConnection);
  ipv6Server.on('connection', trackConnection);
  server.on('upgrade', (request, socket) => {
    origins.push(request.headers.origin);
    socketClosures.push(
      new Promise<void>((resolve) => socket.once('close', resolve)),
    );
    if (options.stallHandshake) {
      socket.on('end', () => socket.end());
      return;
    }

    // RN requires an Origin; Expo additionally requires an exact base-URL host.
    const expectedOrigin = `http://${options.originHostname ?? '127.0.0.1'}:${port}`;
    if (request.headers.origin !== expectedOrigin) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }

    const accept = createHash('sha1')
      .update(
        `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      // Decode the masked, unfragmented client frames used for these CDP calls.
      while (pending.length >= 6) {
        const opcode = pending[0] & 0x0f;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          length = pending.readUInt16BE(2);
          offset = 4;
        }
        if (pending.length < offset + 4 + length) {
          return;
        }
        const mask = pending.subarray(offset, offset + 4);
        const payload = Buffer.from(
          pending.subarray(offset + 4, offset + 4 + length),
        );
        pending = pending.subarray(offset + 4 + length);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
        if (opcode === 8) {
          socket.end(Buffer.from([0x88, 0]));
          return;
        }
        const cdpRequest = JSON.parse(payload.toString()) as CdpRequest;
        requests.push(cdpRequest);
        const result = options.response
          ? options.response(cdpRequest, socket)
          : {
              id: cdpRequest.id,
              result: {
                result: {
                  value: cdpRequest.id === 1 ? '{"isHermes":true}' : 2,
                },
              },
            };
        if (result !== undefined) {
          // Include events and unmatched ids to exercise response correlation.
          writeTextFrame(socket, { method: 'Runtime.consoleAPICalled' });
          writeTextFrame(socket, { id: 999, result: {} });
          writeTextFrame(socket, result);
        }
      }
    });
  });

  const stop = async (): Promise<void> => {
    for (const socket of connections) {
      socket.destroy();
    }
    const servers = [server, ipv6Server];
    await Promise.all(
      servers
        .filter((listener) => listener.listening)
        .map(
          async (listener) =>
            new Promise<void>((resolve, reject) => {
              listener.close((error) => (error ? reject(error) : resolve()));
            }),
        ),
    );
  };

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  ({ port } = server.address() as AddressInfo);
  let ipv6Available = false;
  try {
    await new Promise<void>((resolve, reject) => {
      ipv6Server.once('error', reject);
      ipv6Server.listen({ port, host: '::1', ipv6Only: true }, resolve);
    });
    ipv6Available = true;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      !['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(
        String(error.code),
      )
    ) {
      await stop();
      throw error;
    }
  }

  return {
    port,
    ipv6Available,
    origins,
    requests,
    waitForSocketClosures: async (): Promise<void> => {
      await Promise.all(socketClosures);
    },
    stop,
  };
}

function writeTextFrame(socket: Duplex, response: unknown): void {
  const payload = Buffer.from(JSON.stringify(response));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) {
    header[1] = payload.length;
  } else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function input(
  port: number,
  overrides: Partial<RunHermesCdpInput> = {},
): RunHermesCdpInput {
  return {
    appId: 'io.metamask.MetaMask',
    metroPort: port,
    method: 'Runtime.evaluate',
    params: { expression: '1+1', returnByValue: true },
    timeoutMs: 2_000,
    ...overrides,
  };
}

// Node 20 CI runs without the WebSocket flag; run these with
// NODE_OPTIONS="--experimental-websocket" to exercise its real transport too.
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- Feature-detect the experimental Node 20 API.
const hasWebSocket = typeof WebSocket === 'function';
describe.skipIf(!hasWebSocket)('hermes CDP outbound handshake', () => {
  let inspector: Awaited<ReturnType<typeof startInspector>> | undefined;

  afterEach(async () => {
    const activeInspector = inspector;
    inspector = undefined;
    await activeInspector?.stop();
  });

  it.for(['localhost', '127.0.0.1', '[::1]'])(
    'sends an Expo-compatible Origin from a %s target and closes after verified CDP',
    async (hostname, { skip }) => {
      inspector = await startInspector({ hostname });
      skip(
        hostname === '[::1]' && !inspector.ipv6Available,
        'IPv6 loopback is unavailable',
      );
      const onPin = vi.fn();
      const result = await runHermesCdp(input(inspector.port, { onPin }));

      expect(result).toStrictEqual({
        ok: true,
        result: { result: { value: 2 } },
      });
      expect(inspector.origins).toStrictEqual([
        `http://127.0.0.1:${inspector.port}`,
      ]);
      expect(inspector.requests).toStrictEqual([
        {
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: IDENTITY_PROBE_EXPR, returnByValue: true },
        },
        {
          id: 2,
          method: 'Runtime.evaluate',
          params: { expression: '1+1', returnByValue: true },
        },
      ]);
      expect(onPin).toHaveBeenCalledWith('device-1');
      await inspector.waitForSocketClosures();
    },
  );

  it.each(['localhost', 'metro.example'])(
    'sends a custom packager Origin for %s over a local connection',
    async (originHostname) => {
      inspector = await startInspector({ originHostname });
      const result = await runHermesCdp(
        input(inspector.port, {
          origin: `http://${originHostname}:${inspector.port}`,
        }),
      );

      expect(result).toStrictEqual({
        ok: true,
        result: { result: { value: 2 } },
      });
      expect(inspector.origins).toStrictEqual([
        `http://${originHostname}:${inspector.port}`,
      ]);
      await inspector.waitForSocketClosures();
    },
  );

  it('reports a rejected Origin handshake without sending CDP', async () => {
    inspector = await startInspector();
    const onPin = vi.fn();
    const origin = `http://localhost:${inspector.port}`;
    const result = await runHermesCdp(input(inspector.port, { origin, onPin }));

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_CONNECTION_FAILED,
    });
    // Undici may retry a 401 handshake; every attempt must carry the Origin.
    expect(inspector.origins.length).toBeGreaterThan(0);
    expect(inspector.origins.every((observed) => observed === origin)).toBe(
      true,
    );
    expect(inspector.requests).toHaveLength(0);
    expect(onPin).not.toHaveBeenCalled();
    await inspector.waitForSocketClosures();
  });

  it('closes an unanswered handshake after the timeout', async () => {
    inspector = await startInspector({ stallHandshake: true });
    const result = await runHermesCdp(
      input(inspector.port, { timeoutMs: 500 }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_CONNECTION_FAILED,
      message: expect.stringContaining('connection timed out'),
    });
    expect(inspector.origins).toHaveLength(1);
    expect(inspector.requests).toHaveLength(0);
    await inspector.waitForSocketClosures();
  });

  it('closes on a probe timeout without pinning or user execution', async () => {
    inspector = await startInspector({ response: () => undefined });
    const onPin = vi.fn();
    const result = await runHermesCdp(
      input(inspector.port, { timeoutMs: 500, onPin }),
    );

    expect(result).toMatchObject({ ok: false, code: HERMES_TIMEOUT });
    expect(inspector.origins).toHaveLength(1);
    expect(inspector.requests).toHaveLength(1);
    expect(onPin).not.toHaveBeenCalled();
    await inspector.waitForSocketClosures();
  });

  it('preserves CDP errors and closes the socket', async () => {
    inspector = await startInspector({
      response: (request) =>
        request.id === 1
          ? { id: 1, result: { result: { value: '{"isHermes":true}' } } }
          : { id: 2, error: { message: 'Bad params', code: -32602 } },
    });
    const result = await runHermesCdp(input(inspector.port));

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_CDP_FAILED,
      message: expect.stringContaining('Bad params - code -32602'),
    });
    expect(inspector.origins).toHaveLength(1);
    await inspector.waitForSocketClosures();
  });

  it('reports a socket closing before the user response', async () => {
    inspector = await startInspector({
      response: (request, socket) => {
        if (request.id === 2) {
          socket.destroy();
          return undefined;
        }
        return { id: 1, result: { result: { value: '{"isHermes":true}' } } };
      },
    });
    const result = await runHermesCdp(input(inspector.port));

    expect(result).toMatchObject({
      ok: false,
      code: HERMES_CONNECTION_FAILED,
    });
    expect(inspector.origins).toHaveLength(1);
    expect(inspector.requests).toHaveLength(2);
    await inspector.waitForSocketClosures();
  });
});
