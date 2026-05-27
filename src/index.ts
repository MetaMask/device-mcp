export { createBackend, createLazyBackend } from './backends/index.js';
export { createMcpServer } from './server.js';

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
