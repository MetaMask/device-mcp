import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, it, expect, vi } from 'vitest';

import { registerGetElementTextTool } from './get-element-text.js';
import type { DeviceBackend } from '../backends/types.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function createMockBackend(
  overrides: Partial<DeviceBackend> = {},
): DeviceBackend {
  return {
    platform: 'ios',
    getDeviceInfo: vi.fn(),
    snapshot: vi.fn(),
    tapElement: vi.fn(),
    tapCoordinates: vi.fn(),
    typeText: vi.fn(),
    swipe: vi.fn(),
    waitForElement: vi.fn(),
    getAppState: vi.fn(),
    screenshot: vi.fn(),
    openApp: vi.fn(),
    closeApp: vi.fn(),
    pressButton: vi.fn(),
    dismissKeyboard: vi.fn(),
    dismissAlert: vi.fn(),
    getLogs: vi.fn(),
    longPress: vi.fn(),
    scrollToElement: vi.fn(),
    getAlertText: vi.fn(),
    getWindowSize: vi.fn(),
    getContexts: vi.fn(),
    setContext: vi.fn(),
    getClipboard: vi.fn(),
    setClipboard: vi.fn(),
    startScreenRecording: vi.fn(),
    stopScreenRecording: vi.fn(),
    getElementText: vi.fn().mockResolvedValue('Hello World'),
    ...overrides,
  };
}

function getRegisteredHandler(server: McpServer): ToolHandler {
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  return calls[0][2] as ToolHandler;
}

describe('registerGetElementTextTool', () => {
  it('registers the tool with the correct name', () => {
    const server = createMockServer();
    const backend = createMockBackend();
    registerGetElementTextTool(server, backend);

    expect(server.registerTool).toHaveBeenCalledWith(
      'device_get_element_text',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('returns element text on success', async () => {
    const server = createMockServer();
    const backend = createMockBackend();
    registerGetElementTextTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler({ identifier: 'balance-label' });

    expect(backend.getElementText).toHaveBeenCalledWith({
      identifier: 'balance-label',
      label: undefined,
      text: undefined,
      type: undefined,
    });
    expect(result.content[0].text).toBe('Hello World');
  });

  it('returns (empty) when text is empty string', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      getElementText: vi.fn().mockResolvedValue(''),
    });
    registerGetElementTextTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler({ label: 'empty-field' });

    expect(result.content[0].text).toBe('(empty)');
  });

  it('returns error when element is not found', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      getElementText: vi.fn().mockRejectedValue(new Error('Element not found')),
    });
    registerGetElementTextTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler({ identifier: 'missing' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Element not found');
  });
});
