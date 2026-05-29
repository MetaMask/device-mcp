import { describe, it, expect, vi } from 'vitest';

import type { LazyDeviceBackend } from './backends/index.js';
import { createMcpServer } from './server.js';

const EXPECTED_TOOLS = [
  'device_app_state',
  'device_clipboard',
  'device_close_app',
  'device_context',
  'device_dismiss_alert',
  'device_dismiss_keyboard',
  'device_generate_locators',
  'device_get_alert_text',
  'device_get_window_size',
  'device_info',
  'device_list_devices',
  'device_logs',
  'device_long_press',
  'device_open_app',
  'device_press_button',
  'device_screen_recording',
  'device_screenshot',
  'device_scroll_to_element',
  'device_select_device',
  'device_snapshot',
  'device_swipe',
  'device_tap_coordinates',
  'device_tap_element',
  'device_type',
  'device_wait_for',
];

function createStubBackend(): LazyDeviceBackend {
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
    selectDevice: vi.fn(),
    listDevices: vi.fn().mockResolvedValue([]),
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

  it('registers exactly 22 tools', () => {
    const server = createMcpServer(createStubBackend());
    const names = getRegisteredToolNames(server);
    expect(names).toHaveLength(25);
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
