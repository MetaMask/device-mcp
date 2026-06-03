import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { registerListDevicesTool } from './list-devices.js';
import type { LazyDeviceBackend } from '../backends/index.js';

type ToolHandler = () => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function createMockServer() {
  return { registerTool: vi.fn() } as unknown as McpServer;
}

function createMockBackend(
  overrides: Partial<LazyDeviceBackend> = {},
): LazyDeviceBackend {
  return {
    platform: 'ios',
    selectDevice: vi.fn(),
    listDevices: vi.fn().mockResolvedValue([]),
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
    getElementText: vi.fn(),
    ...overrides,
  };
}

function getRegisteredHandler(server: McpServer): ToolHandler {
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  return calls[0][2] as ToolHandler;
}

describe('registerListDevicesTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers tool with correct name', () => {
    const server = createMockServer();
    registerListDevicesTool(server, createMockBackend());

    expect(server.registerTool).toHaveBeenCalledWith(
      'device_list_devices',
      expect.objectContaining({ title: 'List Devices' }),
      expect.any(Function),
    );
  });

  it('returns empty-list message when no devices found', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      listDevices: vi.fn().mockResolvedValue([]),
    });
    registerListDevicesTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler();

    expect(result.content[0].text).toContain('No connected devices found');
  });

  it('returns formatted device list with header', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      listDevices: vi.fn().mockResolvedValue([
        { platform: 'ios', deviceId: 'udid-aaa' },
        { platform: 'android', deviceId: 'emulator-5554' },
      ]),
    });
    registerListDevicesTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler();
    const { text } = result.content[0];

    expect(text).toContain('Platform\tDevice ID');
    expect(text).toContain('ios\tudid-aaa');
    expect(text).toContain('android\temulator-5554');
  });

  it('returns error result when listDevices throws', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      listDevices: vi.fn().mockRejectedValue(new Error('idb not available')),
    });
    registerListDevicesTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler();

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('idb not available');
  });
});
