export type Platform = 'ios' | 'android';

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
};

export type TapResult = {
  success: boolean;
  x: number;
  y: number;
  targetDescription: string;
};

export type AppStateResult = {
  bundleId: string;
  state: string;
  pid?: number;
};

export type ScreenshotResult = {
  data: string;
  format: 'png' | 'jpeg';
  path?: string;
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

export type WindowSize = {
  width: number;
  height: number;
};

export type DeviceBackend = {
  readonly platform: Platform;

  getDeviceInfo(): Promise<DeviceInfo>;

  snapshot(): Promise<SnapshotResult>;

  tapElement(query: ElementQuery): Promise<TapResult>;

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

  screenshot(outputPath?: string): Promise<ScreenshotResult>;

  openApp(bundleId: string): Promise<void>;

  closeApp(bundleId: string): Promise<void>;

  pressButton(button: DeviceButton): Promise<void>;

  dismissKeyboard(): Promise<void>;

  dismissAlert(accept: boolean): Promise<void>;

  getLogs(durationSeconds?: number, filter?: string): Promise<LogsResult>;

  longPress(query: ElementQuery, durationMs?: number): Promise<TapResult>;

  scrollToElement(
    query: ElementQuery,
    direction?: 'up' | 'down',
    maxAttempts?: number,
  ): Promise<UIElement>;

  getAlertText(): Promise<string>;

  getWindowSize(): Promise<WindowSize>;

  getContexts(): Promise<string[]>;

  setContext(context: string): Promise<void>;

  getClipboard(): Promise<string>;

  setClipboard(text: string): Promise<void>;

  startScreenRecording(outputPath?: string): Promise<void>;

  stopScreenRecording(): Promise<string>;

  getElementText(query: ElementQuery): Promise<string>;
};
