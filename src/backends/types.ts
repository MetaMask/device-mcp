export type Platform = 'ios' | 'android';

/**
 * Stable discriminator for the concrete backend implementation. Prefer this
 * over `instanceof`, which is unreliable across dual-package (ESM/CJS) builds.
 */
export type BackendKind = 'idb' | 'adb' | 'appium';

export type DeviceInfo = {
  platform: Platform;
  deviceId: string;
  name: string;
  osVersion: string;
  state: string;
};

export type UIElement = {
  type: string;
  label?: string;
  value?: string;
  identifier?: string;
  frame: { x: number; y: number; width: number; height: number };
  enabled: boolean;
  children?: UIElement[];
};

export type SnapshotResult = {
  platform: Platform;
  hierarchy: UIElement[];
  raw: string;
  timestamp: number;
  /**
   * ADB only: stock uiautomator dump or the bundled instrumentation helper.
   */
  source?: 'dump' | 'instrument';
  /**
   * ADB capture time in ms, including retries and fallbacks, excluding queue wait.
   */
  captureMs?: number;
};

export type TapResult = {
  success: boolean;
  x: number;
  y: number;
  targetDescription: string;
};

export type TapElementOptions = {
  /**
   * The element to tap, already resolved by the caller. Its frame is used as
   * is; the backend does not check that it still matches `query`.
   */
  element?: UIElement;
};

export type AppStateResult = {
  bundleId: string;
  state: string;
  pid?: number;
};

export type ScreenshotResult = {
  /** Base64-encoded image data. */
  data: string;
  format: 'png' | 'jpeg';
  /** File path the screenshot was written to, when captured to disk. */
  path?: string;
};

/** Result of a screenshot captured with `encode: false`: file `path` only, no base64 `data`. */
export type ScreenshotFileResult = {
  data?: undefined;
  format: 'png' | 'jpeg';
  path: string;
};

export type ScreenshotOptions = {
  /** Include base64 image data in the result. Defaults to `true`. */
  encode?: boolean;
};

export type LogEntry = {
  timestamp: string;
  level: string;
  message: string;
};

export type LogsResult = {
  entries: LogEntry[];
  source: string;
};

export type ElementQuery = {
  label?: string;
  identifier?: string;
  text?: string;
  type?: string;
};

export type DeviceButton = 'home' | 'back' | 'enter' | 'lock';

/** Finger direction of a scroll gesture, or `auto` (from the target's position). */
export type ScrollDirection = 'up' | 'down' | 'auto';

export type ScrollToElementResult = {
  /** The element as last read, with its in-view frame. */
  element: UIElement;
  /** Swipes performed (0 when the element was already in view). */
  swipes: number;
  inViewport: true;
};

export type WindowSize = {
  width: number;
  height: number;
};

export type WebViewCdpInput = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs: number;
  urlFilter?: string;
};

export type WebViewCdpOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: string; message: string };

export type DeviceBackend = {
  readonly kind: BackendKind;

  readonly platform: Platform;

  /** Release only resources owned by this backend. Idempotent; never shuts down a device. */
  dispose?(): Promise<void>;

  /**
   * Replace the backend's own device connection (for iOS, its private
   * companion) with a fresh one. Optional; callers use it to recover after a
   * typed transport error. Never shuts down or reboots a device.
   */
  reconnect?(): Promise<void>;

  getDeviceInfo(): Promise<DeviceInfo>;

  snapshot(): Promise<SnapshotResult>;

  /**
   * Taps the element that matches `query`. Pass `options.element` (an element
   * the caller already resolved, for example from `waitForElement`) to tap it
   * without taking a new snapshot.
   */
  tapElement(
    query: ElementQuery,
    options?: TapElementOptions,
  ): Promise<TapResult>;

  tapCoordinates(x: number, y: number): Promise<void>;

  typeText(text: string): Promise<void>;

  swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void>;

  waitForElement(
    query: ElementQuery,
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<UIElement>;

  getAppState(bundleId: string): Promise<AppStateResult>;

  screenshot(
    outputPath?: string,
    options?: { encode?: true },
  ): Promise<ScreenshotResult>;
  screenshot(
    outputPath: string | undefined,
    options: { encode: false },
  ): Promise<ScreenshotFileResult>;
  screenshot(
    outputPath?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult | ScreenshotFileResult>;

  openApp(bundleId: string): Promise<void>;

  closeApp(bundleId: string): Promise<void>;

  pressButton(button: DeviceButton): Promise<void>;

  dismissKeyboard(): Promise<void>;

  dismissAlert(accept: boolean): Promise<void>;

  getLogs(durationSeconds?: number, filter?: string): Promise<LogsResult>;

  longPress(query: ElementQuery, durationMs?: number): Promise<TapResult>;

  /**
   * Swipe until the element is in the viewport (not only in the UI tree).
   *
   * @param query - The element to bring into view.
   * @param direction - Finger direction (`up` reveals content below), or
   * `auto` (default): from the element's position, searching downward first
   * when it is not in the tree yet.
   * @param maxAttempts - Maximum number of swipes (default 10).
   * @returns The element as last read and the number of swipes.
   * @throws {ScrollToElementError} `ELEMENT_NOT_FOUND` or
   * `ELEMENT_NOT_IN_VIEWPORT` (with the last frame).
   */
  scrollToElement(
    query: ElementQuery,
    direction?: ScrollDirection,
    maxAttempts?: number,
  ): Promise<ScrollToElementResult>;

  getAlertText(): Promise<string>;

  getWindowSize(): Promise<WindowSize>;

  getContexts(): Promise<string[]>;

  setContext(context: string): Promise<void>;

  webviewCdp?(input: WebViewCdpInput): Promise<WebViewCdpOutcome>;

  getClipboard(): Promise<string>;

  setClipboard(text: string): Promise<void>;

  startScreenRecording(outputPath?: string): Promise<void>;

  stopScreenRecording(): Promise<string>;

  getElementText(query: ElementQuery): Promise<string>;
};
