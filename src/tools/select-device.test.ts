import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { registerSelectDeviceTool } from './select-device.js';
import type { LazyDeviceBackend } from '../backends/index.js';

type ToolHandler = (input: { deviceId: string }) => Promise<{
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
    getDeviceInfo: vi.fn().mockResolvedValue({
      platform: 'ios',
      deviceId: 'test-udid',
      name: 'Test iPhone',
      osVersion: '18.0',
      state: 'Booted',
    }),
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

describe('registerSelectDeviceTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers tool with correct name and schema', () => {
    const server = createMockServer();
    registerSelectDeviceTool(server, createMockBackend());

    expect(server.registerTool).toHaveBeenCalledWith(
      'device_select_device',
      expect.objectContaining({ title: 'Select Device' }),
      expect.any(Function),
    );
  });

  it('calls selectDevice then getDeviceInfo on success', async () => {
    const server = createMockServer();
    const backend = createMockBackend();
    registerSelectDeviceTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler({ deviceId: 'udid-aaa' });

    expect(backend.selectDevice).toHaveBeenCalledWith('udid-aaa');
    expect(backend.getDeviceInfo).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('Selected device: Test iPhone');
    expect(result.content[0].text).toContain('Platform: ios');
    expect(result.content[0].text).toContain('OS: 18.0');
    expect(result.content[0].text).toContain('ID: test-udid');
  });

  it('returns error when getDeviceInfo fails after selection', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      getDeviceInfo: vi
        .fn()
        .mockRejectedValue(
          new Error('Cannot determine platform for device ID: bad-id'),
        ),
    });
    registerSelectDeviceTool(server, backend);

    const handler = getRegisteredHandler(server);
    const result = await handler({ deviceId: 'bad-id' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      'Cannot determine platform for device ID: bad-id',
    );
  });

  it('calls selectDevice before getDeviceInfo even on failure', async () => {
    const server = createMockServer();
    const backend = createMockBackend({
      getDeviceInfo: vi.fn().mockRejectedValue(new Error('fail')),
    });
    registerSelectDeviceTool(server, backend);

    const handler = getRegisteredHandler(server);
    await handler({ deviceId: 'some-id' });

    expect(backend.selectDevice).toHaveBeenCalledWith('some-id');
  });
});
