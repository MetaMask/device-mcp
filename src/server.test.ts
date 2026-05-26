import { describe, it, expect, vi } from 'vitest';

import type { DeviceBackend } from './backends/types.js';
import { createMcpServer } from './server.js';

const EXPECTED_TOOLS = [
  'device_app_state',
  'device_close_app',
  'device_dismiss_alert',
  'device_dismiss_keyboard',
  'device_info',
  'device_logs',
  'device_long_press',
  'device_open_app',
  'device_press_button',
  'device_screenshot',
  'device_snapshot',
  'device_swipe',
  'device_tap_coordinates',
  'device_tap_element',
  'device_type',
  'device_wait_for',
];

function createStubBackend(): DeviceBackend {
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
  };
}

function getRegisteredToolNames(
  server: ReturnType<typeof createMcpServer>,
): string[] {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, unknown> | Map<string, unknown>;
    }
  )._registeredTools;

  if (tools instanceof Map) {
    return [...tools.keys()].sort();
  }
  return Object.keys(tools).sort();
}

describe('createMcpServer', () => {
  it('creates a server instance', () => {
    const server = createMcpServer(createStubBackend());
    expect(server).toBeDefined();
    expect(server.server).toBeDefined();
  });

  it('registers exactly 16 tools', () => {
    const server = createMcpServer(createStubBackend());
    const names = getRegisteredToolNames(server);
    expect(names).toHaveLength(16);
  });

  it('registers all expected tool names', () => {
    const server = createMcpServer(createStubBackend());
    const names = getRegisteredToolNames(server);
    expect(names).toStrictEqual(EXPECTED_TOOLS);
  });

  it('no duplicate tool registrations', () => {
    const server = createMcpServer(createStubBackend());
    const names = getRegisteredToolNames(server);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});
