import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { registerWebViewCdpTool } from './webview-cdp.js';
import type { DeviceBackend } from '../backends/types.js';

type CdpHandlerArgs = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  urlFilter?: string;
};

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

function createMockServer(): McpServer {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function getHandler(
  server: McpServer,
): (args: CdpHandlerArgs) => Promise<ToolResult> {
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  return calls[0][2] as (args: CdpHandlerArgs) => Promise<ToolResult>;
}

function createBackend(overrides: Partial<DeviceBackend> = {}): DeviceBackend {
  return { platform: 'android', ...overrides } as unknown as DeviceBackend;
}

describe('registerWebViewCdpTool', () => {
  it('registers the tool with the correct name', () => {
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend());

    expect(server.registerTool).toHaveBeenCalledWith(
      'webview_cdp',
      expect.objectContaining({ title: 'WebView CDP' }),
      expect.any(Function),
    );
  });

  it('returns the CDP result as formatted JSON text on success', async () => {
    const webviewCdp = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { result: { value: 'ok' } } });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    const handler = getHandler(server);
    const result = await handler({
      method: 'Runtime.evaluate',
      params: { expression: "document.querySelector('#x').click()" },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toStrictEqual({
      result: { value: 'ok' },
    });
  });

  it('clamps timeoutMs above the maximum to 120_000', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    await getHandler(server)({ method: 'Runtime.evaluate', timeoutMs: 999_999 });

    expect(webviewCdp).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 120_000 }),
    );
  });

  it('floors a tiny timeoutMs to the minimum (1_000)', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    await getHandler(server)({ method: 'Runtime.evaluate', timeoutMs: 10 });

    expect(webviewCdp).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
  });

  it('defaults timeoutMs to 30_000 when omitted', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    await getHandler(server)({ method: 'Runtime.evaluate' });

    expect(webviewCdp).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it('passes urlFilter through', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({ ok: true, result: {} });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    await getHandler(server)({
      method: 'Runtime.evaluate',
      urlFilter: 'test-dapp',
    });

    expect(webviewCdp).toHaveBeenCalledWith(
      expect.objectContaining({ urlFilter: 'test-dapp' }),
    );
  });

  it('maps a failure result to an error result containing [CODE]', async () => {
    const webviewCdp = vi.fn().mockResolvedValue({
      ok: false,
      code: 'WEBVIEW_TARGET_NOT_FOUND',
      message: 'No debuggable WebView page found',
    });
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    const result = await getHandler(server)({ method: 'Runtime.evaluate' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('[WEBVIEW_TARGET_NOT_FOUND]');
  });

  it('errors when the backend lacks webviewCdp support', async () => {
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend());

    const result = await getHandler(server)({ method: 'Runtime.evaluate' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('only available on an Android');
  });

  it('returns an error result when the backend throws', async () => {
    const webviewCdp = vi.fn().mockRejectedValue(new Error('boom'));
    const server = createMockServer();
    registerWebViewCdpTool(server, createBackend({ webviewCdp }));

    const result = await getHandler(server)({ method: 'Runtime.evaluate' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });
});
