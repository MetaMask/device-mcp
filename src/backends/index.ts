import { AdbBackend } from './adb-backend.js';
import { AppiumBackend } from './appium-backend.js';
import { IdbBackend } from './idb-backend.js';
import { readSessionFile } from './session-file.js';
import type {
  DeviceBackend,
  DeviceButton,
  DeviceInfo,
  LogsResult,
  ScreenshotResult,
  SnapshotResult,
  TapResult,
  AppStateResult,
  ElementQuery,
  UIElement,
  Platform,
} from './types.js';
import { detectPlatform } from '../utils/platform.js';

export type { DeviceBackend } from './types.js';
export { AdbBackend } from './adb-backend.js';
export { AppiumBackend } from './appium-backend.js';
export { IdbBackend } from './idb-backend.js';

export async function createBackend(
  explicitDeviceId?: string,
): Promise<DeviceBackend> {
  const sessionConfig = await readSessionFile();

  if (sessionConfig) {
    console.error(
      `Found .device-session (${sessionConfig.mode}, ${sessionConfig.platform})`,
    );
    const backend = new AppiumBackend(sessionConfig);
    await backend.ensureConnected();
    return backend;
  }

  const { platform, deviceId } = await detectPlatform(explicitDeviceId);

  const backend =
    platform === 'ios' ? new IdbBackend(deviceId) : new AdbBackend(deviceId);

  await backend.ensureConnected();
  return backend;
}

/**
 * Lazy backend that defers device detection to first tool call.
 * Allows the MCP server to start and complete the handshake
 * even when no device is connected yet.
 *
 * @param explicitDeviceId - Optional device ID override.
 * @returns A DeviceBackend that resolves on first use.
 */
export function createLazyBackend(explicitDeviceId?: string): DeviceBackend {
  let inner: DeviceBackend | null = null;
  let connecting: Promise<DeviceBackend> | null = null;

  async function resolve(): Promise<DeviceBackend> {
    if (inner) {
      return inner;
    }
    if (!connecting) {
      connecting = createBackend(explicitDeviceId).then((backend) => {
        inner = backend;
        return backend;
      });
    }
    return connecting;
  }

  return {
    get platform(): Platform {
      return inner?.platform ?? 'ios';
    },

    async getDeviceInfo(): Promise<DeviceInfo> {
      return (await resolve()).getDeviceInfo();
    },

    async snapshot(): Promise<SnapshotResult> {
      return (await resolve()).snapshot();
    },

    async tapElement(query: ElementQuery): Promise<TapResult> {
      return (await resolve()).tapElement(query);
    },

    async tapCoordinates(x: number, y: number): Promise<void> {
      return (await resolve()).tapCoordinates(x, y);
    },

    async typeText(text: string): Promise<void> {
      return (await resolve()).typeText(text);
    },

    async swipe(
      direction: 'up' | 'down' | 'left' | 'right',
      startX?: number,
      startY?: number,
      distance?: number,
    ): Promise<void> {
      return (await resolve()).swipe(direction, startX, startY, distance);
    },

    async waitForElement(
      query: ElementQuery,
      timeoutMs?: number,
      intervalMs?: number,
    ): Promise<UIElement> {
      return (await resolve()).waitForElement(query, timeoutMs, intervalMs);
    },

    async getAppState(bundleId: string): Promise<AppStateResult> {
      return (await resolve()).getAppState(bundleId);
    },

    async screenshot(outputPath?: string): Promise<ScreenshotResult> {
      return (await resolve()).screenshot(outputPath);
    },

    async openApp(bundleId: string): Promise<void> {
      return (await resolve()).openApp(bundleId);
    },

    async closeApp(bundleId: string): Promise<void> {
      return (await resolve()).closeApp(bundleId);
    },

    async pressButton(button: DeviceButton): Promise<void> {
      return (await resolve()).pressButton(button);
    },

    async dismissKeyboard(): Promise<void> {
      return (await resolve()).dismissKeyboard();
    },

    async dismissAlert(accept: boolean): Promise<void> {
      return (await resolve()).dismissAlert(accept);
    },

    async getLogs(
      durationSeconds?: number,
      filter?: string,
    ): Promise<LogsResult> {
      return (await resolve()).getLogs(durationSeconds, filter);
    },

    async longPress(
      query: ElementQuery,
      durationMs?: number,
    ): Promise<TapResult> {
      return (await resolve()).longPress(query, durationMs);
    },
  };
}
