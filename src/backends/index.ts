import { AdbBackend } from './adb-backend.js';
import type { AdbBackendOptions } from './adb-backend.js';
import { AppiumBackend } from './appium-backend.js';
import { IdbBackend } from './idb-backend.js';
import { readSessionFile } from './session-file.js';
import type {
  BackendKind,
  DeviceBackend,
  DeviceButton,
  DeviceInfo,
  LogsResult,
  ScreenshotResult,
  ScreenshotFileResult,
  ScreenshotOptions,
  SnapshotResult,
  TapResult,
  AppStateResult,
  ElementQuery,
  UIElement,
  Platform,
  WindowSize,
  WebViewCdpInput,
  WebViewCdpOutcome,
} from './types.js';
import {
  detectPlatform,
  detectAllDevices,
  MultipleDevicesError,
} from '../utils/platform.js';
import type { DetectedDevice } from '../utils/platform.js';

export type { DeviceBackend } from './types.js';
export { AdbBackend } from './adb-backend.js';
export type { AdbBackendOptions, AdbSnapshotMode } from './adb-backend.js';
export { AppiumBackend } from './appium-backend.js';
export { IdbBackend } from './idb-backend.js';

export type LazyDeviceBackend = DeviceBackend & {
  selectDevice(deviceId: string): Promise<void>;
  listDevices(): Promise<DetectedDevice[]>;
};

export type CreateBackendOptions = {
  /** Options for the ADB backend. Ignored for the other backends. */
  adb?: AdbBackendOptions;
};

/**
 * Connect to a device and create its backend.
 *
 * @param explicitDeviceId - The device to use. Detected when omitted.
 * @param explicitPlatform - The platform to use. Detected when omitted.
 * @param options - Optional per-backend options.
 * @returns The connected backend.
 */
export async function createBackend(
  explicitDeviceId?: string,
  explicitPlatform?: Platform,
  options: CreateBackendOptions = {},
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

  const backend: DeviceBackend & { ensureConnected(): Promise<void> } =
    platform === 'ios'
      ? new IdbBackend(deviceId)
      : new AdbBackend(deviceId, options.adb);

  try {
    await backend.ensureConnected();
  } catch (error) {
    await backend.dispose?.();
    throw error;
  }
  return backend;
}

export function createLazyBackend(
  explicitDeviceId?: string,
  explicitPlatform?: Platform,
  backendOptions: CreateBackendOptions = {},
): LazyDeviceBackend {
  let inner: DeviceBackend | null = null;
  let connecting: Promise<DeviceBackend> | null = null;
  let pendingDevices: DetectedDevice[] | null = null;
  let selectedOverride: string | null = null;
  let disposed = false;
  let disposing: Promise<void> | null = null;
  let selecting: Promise<void> | null = null;

  async function resolve(): Promise<DeviceBackend> {
    await selecting;
    if (disposed) {
      throw new Error('Device backend has been disposed');
    }
    if (inner) {
      return inner;
    }

    if (pendingDevices && !selectedOverride) {
      throw new MultipleDevicesError(pendingDevices);
    }

    if (!connecting) {
      const deviceId = selectedOverride ?? explicitDeviceId;
      connecting = createBackend(deviceId, explicitPlatform, backendOptions)
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
    const backend = await connecting;
    if (disposed) {
      throw new Error('Device backend has been disposed');
    }
    if (selecting) {
      return resolve();
    }
    return backend;
  }

  function screenshot(
    outputPath?: string,
    options?: { encode?: true },
  ): Promise<ScreenshotResult>;
  function screenshot(
    outputPath: string | undefined,
    options: { encode: false },
  ): Promise<ScreenshotFileResult>;
  function screenshot(
    outputPath?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult | ScreenshotFileResult>;
  async function screenshot(
    outputPath?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult | ScreenshotFileResult> {
    return (await resolve()).screenshot(outputPath, options);
  }

  return {
    get kind(): BackendKind {
      return inner?.kind ?? 'idb';
    },

    get platform(): Platform {
      return inner?.platform ?? 'ios';
    },

    async selectDevice(deviceId: string): Promise<void> {
      if (disposed) {
        throw new Error('Device backend has been disposed');
      }
      const previous = selecting;
      const selection = (async (): Promise<void> => {
        await previous;
        const backend = inner ?? (await connecting?.catch(() => null));
        await backend?.dispose?.();
        selectedOverride = deviceId;
        // resolve waits for selecting; no new connection can race these resets.
        inner = null; // eslint-disable-line require-atomic-updates
        connecting = null; // eslint-disable-line require-atomic-updates
      })();
      selecting = selection;
      try {
        await selection;
      } finally {
        if (selecting === selection) {
          selecting = null;
        }
      }
    },

    async dispose(): Promise<void> {
      disposed = true;
      disposing ??= (async (): Promise<void> => {
        await selecting?.catch(() => undefined);
        const backend = inner ?? (await connecting?.catch(() => null));
        await backend?.dispose?.();
        // disposed prevents new connections while the current one is drained.
        inner = null; // eslint-disable-line require-atomic-updates
        connecting = null; // eslint-disable-line require-atomic-updates
      })().catch((error: unknown) => {
        disposing = null;
        throw error;
      });
      await disposing;
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

    screenshot,

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

    async webviewCdp(input: WebViewCdpInput): Promise<WebViewCdpOutcome> {
      const backend = await resolve();
      if (!backend.webviewCdp) {
        return {
          ok: false,
          code: 'WEBVIEW_NOT_SUPPORTED',
          message: `WebView CDP is not supported on the ${backend.kind} backend.`,
        };
      }
      return backend.webviewCdp(input);
    },
  };
}
