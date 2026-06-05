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
  WindowSize,
} from './types.js';
import {
  detectPlatform,
  detectAllDevices,
  MultipleDevicesError,
} from '../utils/platform.js';
import type { DetectedDevice } from '../utils/platform.js';

export type { DeviceBackend } from './types.js';
export { AdbBackend } from './adb-backend.js';
export { AppiumBackend } from './appium-backend.js';
export { IdbBackend } from './idb-backend.js';

export type LazyDeviceBackend = DeviceBackend & {
  selectDevice(deviceId: string): void;
  listDevices(): Promise<DetectedDevice[]>;
};

export async function createBackend(
  explicitDeviceId?: string,
  explicitPlatform?: Platform,
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

  const { platform, deviceId } = await detectPlatform(
    explicitDeviceId,
    explicitPlatform,
  );

  const backend =
    platform === 'ios' ? new IdbBackend(deviceId) : new AdbBackend(deviceId);

  await backend.ensureConnected();
  return backend;
}

export function createLazyBackend(
  explicitDeviceId?: string,
  explicitPlatform?: Platform,
): LazyDeviceBackend {
  let inner: DeviceBackend | null = null;
  let connecting: Promise<DeviceBackend> | null = null;
  let pendingDevices: DetectedDevice[] | null = null;
  let selectedOverride: string | null = null;

  async function resolve(): Promise<DeviceBackend> {
    if (inner) {
      return inner;
    }

    if (pendingDevices && !selectedOverride) {
      throw new MultipleDevicesError(pendingDevices);
    }

    if (!connecting) {
      const deviceId = selectedOverride ?? explicitDeviceId;
      connecting = createBackend(deviceId, explicitPlatform)
        .then((backend) => {
          inner = backend;
          pendingDevices = null;
          return backend;
        })
        .catch((error: unknown) => {
          connecting = null;
          if (error instanceof MultipleDevicesError) {
            pendingDevices = error.devices;
          }
          throw error;
        });
    }
    return connecting;
  }

  return {
    get platform(): Platform {
      return inner?.platform ?? 'ios';
    },

    selectDevice(deviceId: string): void {
      selectedOverride = deviceId;
      inner = null;
      connecting = null;
    },

    async listDevices(): Promise<DetectedDevice[]> {
      if (pendingDevices) {
        return pendingDevices;
      }
      return detectAllDevices(explicitPlatform);
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

    async scrollToElement(
      query: ElementQuery,
      direction?: 'up' | 'down',
      maxAttempts?: number,
    ): Promise<UIElement> {
      return (await resolve()).scrollToElement(query, direction, maxAttempts);
    },

    async getAlertText(): Promise<string> {
      return (await resolve()).getAlertText();
    },

    async getWindowSize(): Promise<WindowSize> {
      return (await resolve()).getWindowSize();
    },

    async getContexts(): Promise<string[]> {
      return (await resolve()).getContexts();
    },

    async setContext(context: string): Promise<void> {
      return (await resolve()).setContext(context);
    },

    async getClipboard(): Promise<string> {
      return (await resolve()).getClipboard();
    },

    async setClipboard(text: string): Promise<void> {
      return (await resolve()).setClipboard(text);
    },

    async startScreenRecording(outputPath?: string): Promise<void> {
      return (await resolve()).startScreenRecording(outputPath);
    },

    async stopScreenRecording(): Promise<string> {
      return (await resolve()).stopScreenRecording();
    },

    async getElementText(query: ElementQuery): Promise<string> {
      return (await resolve()).getElementText(query);
    },
  };
}
