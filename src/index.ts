export { createBackend, createLazyBackend } from './backends/index.js';
export type { LazyDeviceBackend } from './backends/index.js';
export { createMcpServer } from './server.js';

export { detectAllDevices, MultipleDevicesError } from './utils/platform.js';
export type { DetectedDevice } from './utils/platform.js';

export type {
  DeviceBackend,
  DeviceButton,
  DeviceInfo,
  UIElement,
  ElementQuery,
  SnapshotResult,
  ScreenshotResult,
  LogsResult,
  TapResult,
  AppStateResult,
  Platform,
  WindowSize,
} from './backends/types.js';

export type { SessionConfig } from './backends/session-file.js';
