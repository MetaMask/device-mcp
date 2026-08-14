// Derived from agent-device (MIT, Copyright (c) 2026 Callstack)
// https://github.com/callstackincubator/agent-device/blob/336bf17af44e9be1810592d5dc42163771c3e8de/src/platforms/android/snapshot-helper-types.ts
// See ./vendor/NOTICE.md and ./vendor/LICENSE.MIT for attribution.

export const ANDROID_SNAPSHOT_HELPER_NAME = 'android-snapshot-helper' as const;

export const ANDROID_SNAPSHOT_HELPER_PACKAGE =
  'com.callstack.agentdevice.snapshothelper' as const;

export const ANDROID_SNAPSHOT_HELPER_RUNNER =
  'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation' as const;

export const ANDROID_SNAPSHOT_HELPER_PROTOCOL =
  'android-snapshot-helper-v1' as const;

export const ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT = 'uiautomator-xml' as const;

export const ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS = 500;

export const ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS = 5_000;

/**
 * Device-scoped adb executor. Implementations must already inject `-s <serial>`
 * so callers only pass the remaining adb arguments.
 */
export type AndroidAdbExecutor = (
  args: string[],
  options?: AndroidAdbExecutorOptions,
) => Promise<AndroidAdbExecutorResult>;

export type AndroidAdbExecutorOptions = {
  /** When true, a non-zero exit is returned in the result instead of thrown. */
  allowFailure?: boolean;
  timeoutMs?: number;
};

export type AndroidAdbExecutorResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type AndroidSnapshotHelperInstallPolicy =
  | 'missing-or-outdated'
  | 'always'
  | 'never';

export type AndroidSnapshotHelperInstallReason =
  | 'missing'
  | 'outdated'
  | 'forced'
  | 'current'
  | 'skipped';

export type AndroidSnapshotHelperInstallResult = {
  packageName: string;
  versionCode: number;
  installedVersionCode?: number;
  installed: boolean;
  reason: AndroidSnapshotHelperInstallReason;
};

export type AndroidSnapshotHelperManifest = {
  name: typeof ANDROID_SNAPSHOT_HELPER_NAME;
  version: string;
  releaseTag?: string;
  assetName?: string;
  apkUrl: string | null;
  sha256: string;
  expectedSignerSha256: string;
  checksumName?: string;
  packageName: string;
  versionCode: number;
  instrumentationRunner: string;
  minSdk: number;
  targetSdk?: number;
  outputFormat: typeof ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT;
  statusProtocol: typeof ANDROID_SNAPSHOT_HELPER_PROTOCOL;
  installArgs: string[];
};

export type AndroidSnapshotHelperArtifact = {
  apkPath: string;
  manifest: AndroidSnapshotHelperManifest;
};

export type AndroidSnapshotHelperCaptureMode =
  | 'interactive-windows'
  | 'active-window';

export type AndroidSnapshotHelperMetadata = {
  helperApiVersion?: string;
  outputFormat: typeof ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT;
  waitForIdleTimeoutMs?: number;
  timeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
  rootPresent?: boolean;
  captureMode?: AndroidSnapshotHelperCaptureMode;
  windowCount?: number;
  nodeCount?: number;
  truncated?: boolean;
  elapsedMs?: number;
};

export type AndroidSnapshotHelperOutput = {
  xml: string;
  metadata: AndroidSnapshotHelperMetadata;
};

export type AndroidSnapshotHelperCaptureOptions = {
  adb: AndroidAdbExecutor;
  packageName?: string;
  instrumentationRunner?: string;
  waitForIdleTimeoutMs?: number;
  timeoutMs?: number;
  commandTimeoutMs?: number;
  maxDepth?: number;
  maxNodes?: number;
};
