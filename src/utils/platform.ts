import { exec, isCommandAvailable } from './exec.js';
import type { Platform } from '../backends/types.js';

type DetectedDevice = {
  platform: Platform;
  deviceId: string;
};

export async function detectPlatform(
  explicitDeviceId?: string,
): Promise<DetectedDevice> {
  if (explicitDeviceId) {
    return detectFromExplicitId(explicitDeviceId);
  }

  const [hasIdb, hasAdb] = await Promise.all([
    isCommandAvailable('idb'),
    isCommandAvailable('adb'),
  ]);

  if (hasIdb) {
    const iosDevice = await findBootedIOSDevice();
    if (iosDevice) {
      return iosDevice;
    }
  }

  if (hasAdb) {
    const androidDevice = await findConnectedAndroidDevice();
    if (androidDevice) {
      return androidDevice;
    }
  }

  throw new Error(
    'No connected device found.\n' +
      `  iOS (idb): ${hasIdb ? 'available, no booted simulator' : 'not installed'}\n` +
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

async function findBootedIOSDevice(): Promise<DetectedDevice | null> {
  const result = await exec('idb', ['list-targets', '--json']);
  if (result.exitCode !== 0) {
    return null;
  }

  for (const line of result.stdout.trim().split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const target = JSON.parse(line);
      if (target.state === 'Booted' && target.type === 'simulator') {
        return { platform: 'ios', deviceId: target.udid };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function findConnectedAndroidDevice(): Promise<DetectedDevice | null> {
  const result = await exec('adb', ['devices']);
  if (result.exitCode !== 0) {
    return null;
  }

  const lines = result.stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    const [serial, state] = line.trim().split(/\s+/u);
    if (serial && state === 'device') {
      return { platform: 'android', deviceId: serial };
    }
  }
  return null;
}
