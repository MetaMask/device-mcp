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

export {
  runHermesCdp,
  fetchDiscoveryTargets,
  selectHermesTarget,
  hasAmbiguousTarget,
  validateWebSocketUrl,
  LEGACY_SYNTHETIC_TITLE,
} from './hermes/hermes-cdp.js';
export type {
  HermesTarget,
  HermesCdpResult,
  RunHermesCdpInput,
} from './hermes/hermes-cdp.js';

export {
  HermesSession,
  getHermesSession,
  resetHermesSession,
  defaultAppIdForPlatform,
  DEFAULT_IOS_APP_ID,
  DEFAULT_ANDROID_APP_ID,
  DEFAULT_METRO_PORT,
} from './hermes/session.js';
export type {
  HermesPlatform,
  HermesSessionOptions,
  HermesSessionResolved,
  HermesSessionResolveInput,
} from './hermes/session.js';
