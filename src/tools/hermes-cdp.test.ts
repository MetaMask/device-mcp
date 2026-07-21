import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerHermesCdpTool } from './hermes-cdp.js';
import { registerHermesTargetsTool } from './hermes-targets.js';
import type { LazyDeviceBackend } from '../backends/index.js';
import * as core from '../hermes/hermes-cdp.js';
import { getHermesSession, resetHermesSession } from '../hermes/session.js';

vi.mock('../hermes/hermes-cdp.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../hermes/hermes-cdp.js')>();
  return {
    ...actual,
    runHermesCdp: vi.fn(),
    fetchDiscoveryTargets: vi.fn(),
  };
});

const runHermesCdpMock = vi.mocked(core.runHermesCdp);
const fetchDiscoveryTargetsMock = vi.mocked(core.fetchDiscoveryTargets);

type CdpHandlerArgs = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  metroPort?: number;
  appId?: string;
};

type TargetsHandlerArgs = {
  metroPort?: number;
  appId?: string;
  all?: boolean;
};

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

function createMockServer(): McpServer {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function createMockBackend(): LazyDeviceBackend {
  return { platform: 'ios' } as unknown as LazyDeviceBackend;
}

function getCdpHandler(
  server: McpServer,
): (args: CdpHandlerArgs) => Promise<ToolResult> {
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  return calls[0][2] as (args: CdpHandlerArgs) => Promise<ToolResult>;
}

function getTargetsHandler(
  server: McpServer,
): (args: TargetsHandlerArgs) => Promise<ToolResult> {
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  return calls[0][2] as (args: TargetsHandlerArgs) => Promise<ToolResult>;
}

function target(overrides: Record<string, unknown> = {}): core.HermesTarget {
  return {
    id: 'device-page-1',
    title: 'io.metamask.MetaMask (iPhone 15)',
    appId: 'io.metamask.MetaMask',
    webSocketDebuggerUrl: 'ws://localhost:8081/inspector/debug?page=1',
    reactNative: {
      logicalDeviceId: 'logical-device-1',
      capabilities: { nativePageReloads: true },
    },
    ...overrides,
  };
}

describe('registerHermesCdpTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHermesSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHermesSession();
  });

  it('registers the tool with the correct name', () => {
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    expect(server.registerTool).toHaveBeenCalledWith(
      'hermes_cdp',
      expect.objectContaining({ title: 'Hermes CDP' }),
      expect.any(Function),
    );
  });

  it('returns the CDP result as formatted JSON text on success', async () => {
    runHermesCdpMock.mockResolvedValue({
      ok: true,
      result: { result: { type: 'number', value: 2 } },
    });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    const result = await handler({
      method: 'Runtime.evaluate',
      params: { expression: '1+1', returnByValue: true },
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toStrictEqual({
      result: { type: 'number', value: 2 },
    });
  });

  it('maps a failure result to an error result containing [CODE]', async () => {
    runHermesCdpMock.mockResolvedValue({
      ok: false,
      code: core.HERMES_TARGET_NOT_FOUND,
      message: 'No Hermes debug target found for appId io.metamask.MetaMask',
    });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    const result = await handler({ method: 'Runtime.evaluate' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[HERMES_TARGET_NOT_FOUND]');
    expect(result.content[0].text).toContain('No Hermes debug target found');
  });

  it('clamps timeoutMs above the maximum to 120_000', async () => {
    runHermesCdpMock.mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate', timeoutMs: 999_999 });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('passes a smaller timeoutMs through unchanged', async () => {
    runHermesCdpMock.mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate', timeoutMs: 5_000 });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 5_000 }),
    );
  });

  it('floors a tiny timeoutMs to the minimum (1_000)', async () => {
    runHermesCdpMock.mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate', timeoutMs: 10 });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it('defaults timeoutMs to 30_000 when omitted', async () => {
    runHermesCdpMock.mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate' });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('reads the pin from the session and persists a new pin via onPin', async () => {
    runHermesCdpMock.mockImplementation(async (input) => {
      input.onPin?.('logical-device-7');
      return { ok: true, result: {} };
    });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate' });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ pinnedDeviceId: undefined }),
    );
    expect(getHermesSession().getPinnedHermesDeviceId()).toBe(
      'logical-device-7',
    );

    await handler({ method: 'Runtime.evaluate' });
    expect(runHermesCdpMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ pinnedDeviceId: 'logical-device-7' }),
    );
  });

  it('onPin does not overwrite an already-set differing pin (compare-and-set)', async () => {
    getHermesSession().setPinnedHermesDeviceId('logical-device-existing');
    runHermesCdpMock.mockImplementation(async (input) => {
      input.onPin?.('logical-device-other');
      return { ok: true, result: {} };
    });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({ method: 'Runtime.evaluate' });

    expect(getHermesSession().getPinnedHermesDeviceId()).toBe(
      'logical-device-existing',
    );
  });

  it('resolves metroPort and appId overrides through the session', async () => {
    runHermesCdpMock.mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    await handler({
      method: 'Runtime.evaluate',
      metroPort: 8090,
      appId: 'io.custom.app',
    });

    expect(runHermesCdpMock).toHaveBeenCalledWith(
      expect.objectContaining({ metroPort: 8090, appId: 'io.custom.app' }),
    );
  });

  it('returns an error result when the core throws', async () => {
    runHermesCdpMock.mockRejectedValue(new Error('unexpected boom'));
    const server = createMockServer();
    registerHermesCdpTool(server, createMockBackend());

    const handler = getCdpHandler(server);
    const result = await handler({ method: 'Runtime.evaluate' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unexpected boom');
  });
});

describe('registerHermesTargetsTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHermesSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetHermesSession();
  });

  it('registers the tool with the correct name and readOnlyHint', () => {
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    expect(server.registerTool).toHaveBeenCalledWith(
      'hermes_targets',
      expect.objectContaining({
        title: 'Hermes Targets',
        annotations: { readOnlyHint: true },
      }),
      expect.any(Function),
    );
  });

  it('lists candidates and reports the chosen target', async () => {
    fetchDiscoveryTargetsMock.mockResolvedValue([target()]);
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({});
    const { text } = result.content[0];

    expect(text).toContain('Metro port: 8081');
    expect(text).toContain('Expected appId: io.metamask.MetaMask');
    expect(text).toContain('Candidate 1:');
    expect(text).toContain('device-page-1');
    expect(text).toContain('Chosen target: device-page-1');
  });

  it('reports ambiguity when multiple devices are present', async () => {
    fetchDiscoveryTargetsMock.mockResolvedValue([
      target({
        id: 'a',
        reactNative: { logicalDeviceId: 'd1', capabilities: {} },
      }),
      target({
        id: 'b',
        webSocketDebuggerUrl: 'ws://localhost:8081/b',
        reactNative: { logicalDeviceId: 'd2', capabilities: {} },
      }),
    ]);
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({});

    expect(result.content[0].text).toContain('Ambiguous:');
  });

  it('returns a clear message when no targets are discovered', async () => {
    fetchDiscoveryTargetsMock.mockResolvedValue([]);
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({});

    expect(result.content[0].text).toBe(
      'Metro not running or no debuggable app registered.',
    );
  });

  it('returns a clear message when Metro is down (ECONNREFUSED)', async () => {
    fetchDiscoveryTargetsMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({});

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(
      'Metro not running or no debuggable app registered.',
    );
  });

  it('surfaces an error result for non-Metro-down failures', async () => {
    fetchDiscoveryTargetsMock.mockRejectedValue(new Error('weird parse error'));
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('weird parse error');
  });

  it('all:true bypasses the appId filter and lists every target', async () => {
    fetchDiscoveryTargetsMock.mockResolvedValue([
      target({ id: 'mine' }),
      target({
        id: 'theirs',
        appId: 'io.other.app',
        webSocketDebuggerUrl: 'ws://localhost:8081/other',
        reactNative: { logicalDeviceId: 'd2', capabilities: {} },
      }),
    ]);
    const server = createMockServer();
    registerHermesTargetsTool(server, createMockBackend());

    const handler = getTargetsHandler(server);
    const result = await handler({ all: true });
    const { text } = result.content[0];

    expect(text).toContain('(filter bypassed by all=true)');
    expect(text).toContain('Candidates listed: 2');
    expect(text).toContain('mine');
    expect(text).toContain('theirs');
  });
});
