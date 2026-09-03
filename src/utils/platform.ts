import { readdirSync } from 'node:fs';

import { exec, isCommandAvailable } from './exec.js';
import type { Platform } from '../backends/types.js';

export type DetectedDevice = {
  platform: Platform;
  deviceId: string;
};

export class MultipleDevicesError extends Error {
  readonly devices: DetectedDevice[];

  constructor(devices: DetectedDevice[]) {
    const lines = devices.map((d) => `  ${d.platform}\t${d.deviceId}`);
    super(
      `Multiple devices detected. Set DEVICE_ID to one of:\n${lines.join('\n')}`,
    );
    this.name = 'MultipleDevicesError';
    this.devices = devices;
  }
}

/**
 * Detect all connected devices across iOS and Android.
 *
 * @param platform - Optional filter to only return devices of a specific platform.
 * @returns Array of detected devices (may be empty).
 */
export async function detectAllDevices(
  platform?: Platform,
): Promise<DetectedDevice[]> {
  const searches: Promise<DetectedDevice[]>[] = [];

  if (platform !== 'android') {
    searches.push(findAllBootedIOSSimulators().catch(() => []));
  }
  if (platform !== 'ios') {
    searches.push(findAllConnectedAndroidDevices().catch(() => []));
  }

  const results = await Promise.all(searches);
  return results.flat();
}

export async function detectPlatform(
  explicitDeviceId?: string,
  explicitPlatform?: Platform,
): Promise<DetectedDevice> {
  if (explicitDeviceId) {
    return detectFromExplicitId(explicitDeviceId);
  }

  const devices = await detectAllDevices(explicitPlatform);

  if (devices.length === 1) {
    return devices[0];
  }

  if (devices.length > 1) {
    throw new MultipleDevicesError(devices);
  }

  const hasAdb =
    explicitPlatform === 'ios' ? false : await isCommandAvailable('adb');

  const platformLabel = explicitPlatform ?? 'any';
  throw new Error(
    `No connected ${platformLabel} device found.\n` +
      `  iOS (simctl): no booted simulator\n` +
      `  Android (adb): ${hasAdb ? 'available, no connected device' : 'not installed'}\n` +
      'Boot a simulator/emulator or set DEVICE_ID explicitly.',
  );
}

async function detectFromExplicitId(deviceId: string): Promise<DetectedDevice> {
  // UUIDs with dashes are typically iOS simulator UDIDs
  if (/^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/iu.test(deviceId)) {
    return { platform: 'ios', deviceId };
  }

  // Android emulator or device serial patterns
  if (deviceId.startsWith('emulator-') || /^[A-Za-z0-9]+$/u.test(deviceId)) {
    return { platform: 'android', deviceId };
  }

  const [hasIdb, hasAdb] = await Promise.all([
    isCommandAvailable('idb'),
    isCommandAvailable('adb'),
  ]);

  if (hasIdb) {
    const result = await exec('idb', ['describe', '--udid', deviceId]);
    if (result.exitCode === 0) {
      return { platform: 'ios', deviceId };
    }
  }

  if (hasAdb) {
    const result = await exec('adb', ['-s', deviceId, 'get-state']);
    if (result.exitCode === 0) {
      return { platform: 'android', deviceId };
    }
  }

  throw new Error(
    `Cannot determine platform for device ID: ${deviceId}. ` +
      'Ensure the device is connected and idb/adb is available.',
  );
}

type SimctlDevice = {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
};

async function findAllBootedIOSSimulators(): Promise<DetectedDevice[]> {
  const result = await exec('xcrun', [
    'simctl',
    'list',
    'devices',
    'booted',
    '--json',
  ]);
  if (result.exitCode !== 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(result.stdout) as {
      devices: Record<string, SimctlDevice[]>;
    };
    const devices: DetectedDevice[] = [];
    for (const runtimeDevices of Object.values(parsed.devices)) {
      for (const device of runtimeDevices) {
        if (device.state === 'Booted' && device.isAvailable) {
          devices.push({ platform: 'ios', deviceId: device.udid });
        }
      }
    }
    return devices;
  } catch {
    return [];
  }
}

function findPythonBinDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter(
        (e) =>
          (e.isDirectory() && e.name.startsWith('python')) ||
          /^\d+\.\d+$/u.test(e.name),
      )
      .map((e) => `${base}/${e.name}/bin`);
  } catch {
    return [];
  }
}

/**
 * Whether an `idb` binary supports the `--api` describe-all backend selector.
 * Only the unified `idb` (>= ~1.5) exposes it; the legacy python `fb-idb`
 * rejects `--api` as a usage error, so we probe the help text.
 *
 * @param idbPath - The `idb` executable to probe.
 * @returns True when `--api` is accepted.
 */
export async function idbSupportsApiSelection(
  idbPath: string,
): Promise<boolean> {
  const help = await exec(idbPath, ['ui', 'describe-all', '--help']).catch(
    () => null,
  );
  if (help?.exitCode !== 0) {
    return false;
  }
  return `${help.stdout}\n${help.stderr}`.includes('--api');
}

/**
 * Resolve the `idb` executable, preferring one that supports `--api`.
 *
 * A machine can have both the legacy python `fb-idb` (often first on `PATH`)
 * and the unified `facebook/fb/idb`; only the latter supports `--api axbridge`,
 * which iOS 17+ simulators require. We return the first `--api`-capable
 * candidate, falling back to the first merely-working one.
 *
 * @returns The path to the best available `idb`.
 * @throws When no `idb` executable is found.
 */
export async function resolveIdbPath(): Promise<string> {
  const home = process.env.HOME ?? '';
  const candidates = [
    'idb',
    '/opt/homebrew/bin/idb',
    '/usr/local/bin/idb',
    ...findPythonBinDirs(`${home}/Library/Python`).map((d) => `${d}/idb`),
    ...findPythonBinDirs('/usr/local/lib').map((d) => `${d}/idb`),
  ];

  let firstWorking: string | null = null;
  for (const candidate of candidates) {
    const probe = await exec(candidate, ['--help']).catch(() => null);
    if (probe?.exitCode !== 0) {
      continue;
    }
    if (firstWorking === null) {
      firstWorking = candidate;
    }
    if (await idbSupportsApiSelection(candidate)) {
      return candidate;
    }
  }

  if (firstWorking !== null) {
    return firstWorking;
  }

  throw new Error(
    'idb not found.\n' +
      'Install the unified client: brew tap facebook/fb && brew install idb',
  );
}

/**
 * The `--api` accessibility backend for a given iOS runtime.
 *
 * The backends are version-inverted: `ax` works on iOS <= 17 but is broken on
 * iOS 26; `axbridge` works on iOS >= 18. So we pick `axbridge` for >= 18 and
 * `ax` otherwise, or `null` (omit `--api`) when the CLI cannot select. The
 * caller still falls back if the chosen backend errors.
 *
 * @param osVersion - The device OS version (e.g. '17.4', '26.1').
 * @param supportsApi - Whether the resolved CLI accepts `--api`.
 * @returns The `--api` value, or `null` to omit it.
 */
export function chooseAxApi(
  osVersion: string,
  supportsApi: boolean,
): 'ax' | 'axbridge' | null {
  if (!supportsApi) {
    return null;
  }
  const major = Number.parseInt(osVersion, 10);
  if (Number.isNaN(major)) {
    // Unknown version - prefer the modern reader and let the caller fall back
    return 'axbridge';
  }
  return major >= 18 ? 'axbridge' : 'ax';
}

async function resolveAdbPath(): Promise<string> {
  const result = await exec('adb', ['version']).catch(() => null);
  if (result?.exitCode === 0) {
    return 'adb';
  }

  const home = process.env.HOME ?? '';
  const candidates = [
    process.env.ANDROID_HOME &&
      `${process.env.ANDROID_HOME}/platform-tools/adb`,
    process.env.ANDROID_SDK_ROOT &&
      `${process.env.ANDROID_SDK_ROOT}/platform-tools/adb`,
    `${home}/Library/Android/sdk/platform-tools/adb`,
    `${home}/Android/Sdk/platform-tools/adb`,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const probe = await exec(candidate, ['version']).catch(() => null);
    if (probe?.exitCode === 0) {
      return candidate;
    }
  }

  throw new Error('adb not found');
}

async function findAllConnectedAndroidDevices(): Promise<DetectedDevice[]> {
  const adb = await resolveAdbPath();
  const result = await exec(adb, ['devices']);
  if (result.exitCode !== 0) {
    return [];
  }

  const devices: DetectedDevice[] = [];
  const lines = result.stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    const [serial, state] = line.trim().split(/\s+/u);
    if (serial && state === 'device') {
      devices.push({ platform: 'android', deviceId: serial });
    }
  }
  return devices;
}
