import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as execModule from './exec.js';
import {
  detectAllDevices,
  detectPlatform,
  resolveIdbPath,
  MultipleDevicesError,
} from './platform.js';

vi.mock('node:fs', () => ({
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock('./exec.js', () => ({
  exec: vi.fn(),
  isCommandAvailable: vi.fn(),
  execStrict: vi.fn(),
}));

const mockExec = vi.mocked(execModule.exec);
const mockIsCommandAvailable = vi.mocked(execModule.isCommandAvailable);

const simctlTwoBooted = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      {
        udid: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
        name: 'iPhone 16 Pro',
        state: 'Booted',
        isAvailable: true,
      },
      {
        udid: '11112222-3333-4444-5555-666677778888',
        name: 'iPhone 15',
        state: 'Booted',
        isAvailable: true,
      },
    ],
  },
});

const simctlOneBootedOneShutdown = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      {
        udid: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
        name: 'iPhone 16 Pro',
        state: 'Booted',
        isAvailable: true,
      },
      {
        udid: '11112222-3333-4444-5555-666677778888',
        name: 'iPhone 15',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
  },
});

const simctlOneBooted = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      {
        udid: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
        name: 'iPhone 16 Pro',
        state: 'Booted',
        isAvailable: true,
      },
    ],
  },
});

const simctlEmpty = JSON.stringify({ devices: {} });

const adbTwoDevices = `List of devices attached
emulator-5554\tdevice
emulator-5556\tdevice
`;

const adbOneDevice = `List of devices attached
emulator-5554\tdevice
`;

const adbNoDevices = `List of devices attached
`;

function mockExecForCommands(
  responses: Record<string, { exitCode: number; stdout: string }>,
) {
  mockExec.mockImplementation(async (cmd, args) => {
    const key = cmd === 'xcrun' && args?.[0] === 'simctl' ? 'simctl' : cmd;
    const response = responses[key];
    if (response) {
      return { ...response, stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: 'not mocked' };
  });
}

describe('MultipleDevicesError', () => {
  it('includes device list in message', () => {
    const devices = [
      { platform: 'ios' as const, deviceId: 'udid-1' },
      { platform: 'android' as const, deviceId: 'emulator-5554' },
    ];
    const error = new MultipleDevicesError(devices);

    expect(error.name).toBe('MultipleDevicesError');
    expect(error.devices).toBe(devices);
    expect(error.message).toContain('Multiple devices detected');
    expect(error.message).toContain('udid-1');
    expect(error.message).toContain('emulator-5554');
  });
});

describe('detectAllDevices', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns booted iOS simulators via simctl (no idb needed)', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlTwoBooted },
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(2);
    expect(devices[0]).toStrictEqual({
      platform: 'ios',
      deviceId: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
    });
    expect(devices[1]).toStrictEqual({
      platform: 'ios',
      deviceId: '11112222-3333-4444-5555-666677778888',
    });
    expect(mockIsCommandAvailable).not.toHaveBeenCalledWith('idb');
  });

  it('skips shutdown simulators', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlOneBootedOneShutdown },
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0].deviceId).toBe('AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF');
  });

  it('returns empty when simctl reports no booted simulators', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlEmpty },
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });

  it('returns all connected Android devices', async () => {
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlEmpty },
      adb: { exitCode: 0, stdout: adbTwoDevices },
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(2);
    expect(devices[0]).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
    expect(devices[1]).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5556',
    });
  });

  it('combines iOS simulators and Android devices', async () => {
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlOneBooted },
      adb: { exitCode: 0, stdout: adbOneDevice },
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.platform)).toStrictEqual(['ios', 'android']);
  });

  it('filters by platform=ios (skips adb check)', async () => {
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlTwoBooted },
    });

    const devices = await detectAllDevices('ios');

    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.platform === 'ios')).toBe(true);
    expect(mockIsCommandAvailable).not.toHaveBeenCalledWith('adb');
  });

  it('filters by platform=android (skips simctl)', async () => {
    mockExecForCommands({
      adb: { exitCode: 0, stdout: adbTwoDevices },
    });

    const devices = await detectAllDevices('android');

    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.platform === 'android')).toBe(true);
    expect(mockExec).not.toHaveBeenCalledWith('xcrun', expect.anything());
  });

  it('handles simctl failure gracefully', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 1, stdout: '' },
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });

  it('handles adb not installed gracefully (ENOENT)', async () => {
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlEmpty, stderr: '' };
      }
      throw new Error('spawn adb ENOENT');
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });

  it('handles malformed simctl JSON gracefully', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: 'not json' },
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });

  it('skips unavailable simulators', async () => {
    const simctlUnavailable = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
          {
            udid: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
            name: 'iPhone 16 Pro',
            state: 'Booted',
            isAvailable: false,
          },
        ],
      },
    });
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlUnavailable },
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });

  it('iOS failure does not block Android detection', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'xcrun') {
        throw new Error('spawn xcrun ENOENT');
      }
      return { exitCode: 0, stdout: adbOneDevice, stderr: '' };
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
  });

  it('android failure does not block iOS detection', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlOneBooted, stderr: '' };
      }
      throw new Error('spawn adb ENOENT');
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]).toStrictEqual({
      platform: 'ios',
      deviceId: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
    });
  });

  it('finds simulators across multiple runtimes', async () => {
    const simctlMultiRuntime = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-4': [
          {
            udid: 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF',
            name: 'iPhone 15',
            state: 'Booted',
            isAvailable: true,
          },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
          {
            udid: '11112222-3333-4444-5555-666677778888',
            name: 'iPhone 16 Pro',
            state: 'Booted',
            isAvailable: true,
          },
        ],
      },
    });
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlMultiRuntime },
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(2);
  });

  it('resolves adb via ANDROID_HOME when bare adb fails', async () => {
    vi.stubEnv('ANDROID_HOME', '/opt/android-sdk');
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlEmpty, stderr: '' };
      }
      if (cmd === 'adb') {
        throw new Error('spawn adb ENOENT');
      }
      if (cmd === '/opt/android-sdk/platform-tools/adb') {
        if (args?.[0] === 'version') {
          return { exitCode: 0, stdout: '30.0.0', stderr: '' };
        }
        return { exitCode: 0, stdout: adbOneDevice, stderr: '' };
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0].platform).toBe('android');
    vi.unstubAllEnvs();
  });

  it('resolves adb via HOME fallback when bare adb and env vars fail', async () => {
    vi.stubEnv('HOME', '/Users/testuser');
    vi.stubEnv('ANDROID_HOME', '');
    vi.stubEnv('ANDROID_SDK_ROOT', '');
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlEmpty, stderr: '' };
      }
      if (cmd === 'adb') {
        throw new Error('spawn adb ENOENT');
      }
      if (cmd === '/Users/testuser/Library/Android/sdk/platform-tools/adb') {
        if (args?.[0] === 'version') {
          return { exitCode: 0, stdout: '30.0.0', stderr: '' };
        }
        return { exitCode: 0, stdout: adbOneDevice, stderr: '' };
      }
      throw new Error(`unexpected: ${cmd}`);
    });

    const devices = await detectAllDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0].platform).toBe('android');
    vi.unstubAllEnvs();
  });

  it('returns empty when adb is not found at any path', async () => {
    vi.stubEnv('ANDROID_HOME', '');
    vi.stubEnv('ANDROID_SDK_ROOT', '');
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlEmpty, stderr: '' };
      }
      throw new Error('ENOENT');
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
    vi.unstubAllEnvs();
  });
});

describe('detectPlatform', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns single device when only one is available', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlEmpty },
      adb: { exitCode: 0, stdout: adbOneDevice },
    });

    const result = await detectPlatform();

    expect(result).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
  });

  it('throws MultipleDevicesError when multiple devices found', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlTwoBooted },
    });

    await expect(detectPlatform()).rejects.toThrow(MultipleDevicesError);
  });

  it('multipleDevicesError carries the device list', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlTwoBooted },
    });

    try {
      await detectPlatform();
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MultipleDevicesError);
      expect((error as MultipleDevicesError).devices).toHaveLength(2);
    }
  });

  it('narrows to single device when explicitPlatform filters to one', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExecForCommands({
      adb: { exitCode: 0, stdout: adbOneDevice },
    });

    const result = await detectPlatform(undefined, 'android');

    expect(result).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
  });

  it('throws when no devices found', async () => {
    mockIsCommandAvailable.mockResolvedValue(false);
    mockExecForCommands({
      simctl: { exitCode: 0, stdout: simctlEmpty },
    });

    await expect(detectPlatform()).rejects.toThrow(
      'No connected any device found',
    );
  });

  it('throws with platform label when explicitPlatform set and no devices', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExecForCommands({
      adb: { exitCode: 0, stdout: adbNoDevices },
    });

    await expect(detectPlatform(undefined, 'android')).rejects.toThrow(
      'No connected android device found',
    );
  });

  it('bypasses auto-detect when explicitDeviceId is a UUID', async () => {
    const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';

    const result = await detectPlatform(udid);

    expect(result).toStrictEqual({ platform: 'ios', deviceId: udid });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('bypasses auto-detect when explicitDeviceId is an emulator serial', async () => {
    const result = await detectPlatform('emulator-5554');

    expect(result).toStrictEqual({
      platform: 'android',
      deviceId: 'emulator-5554',
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('probes idb for ambiguous device ID and returns ios on success', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' });

    const result = await detectPlatform('some-custom-id');

    expect(result).toStrictEqual({
      platform: 'ios',
      deviceId: 'some-custom-id',
    });
    expect(mockExec).toHaveBeenCalledWith('idb', [
      'describe',
      '--udid',
      'some-custom-id',
    ]);
  });

  it('falls back to adb probe when idb fails for ambiguous device ID', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExec.mockImplementation(async (cmd) => {
      if (cmd === 'idb') {
        return { exitCode: 1, stdout: '', stderr: 'not found' };
      }
      return { exitCode: 0, stdout: 'device', stderr: '' };
    });

    const result = await detectPlatform('some-custom-id');

    expect(result).toStrictEqual({
      platform: 'android',
      deviceId: 'some-custom-id',
    });
  });

  it('throws when ambiguous device ID is not found by idb or adb', async () => {
    mockIsCommandAvailable.mockResolvedValue(true);
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

    await expect(detectPlatform('some-custom-id')).rejects.toThrow(
      'Cannot determine platform for device ID: some-custom-id',
    );
  });

  it('skips idb probe when idb is not available', async () => {
    mockIsCommandAvailable.mockImplementation(async (cmd) => cmd === 'adb');
    mockExec.mockResolvedValue({ exitCode: 0, stdout: 'device', stderr: '' });

    const result = await detectPlatform('some-custom-id');

    expect(result).toStrictEqual({
      platform: 'android',
      deviceId: 'some-custom-id',
    });
  });
});

describe('resolveIdbPath', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns bare idb when it is on PATH', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const path = await resolveIdbPath();

    expect(path).toBe('idb');
  });

  it('finds idb in /usr/local/bin when bare idb fails', async () => {
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === 'idb') {
        throw new Error('ENOENT');
      }
      if (cmd === '/usr/local/bin/idb') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error('ENOENT');
    });

    const path = await resolveIdbPath();

    expect(path).toBe('/usr/local/bin/idb');
  });

  it('finds idb via Python bin dir scan', async () => {
    const { readdirSync } = await import('node:fs');
    const mockReaddir = vi.mocked(readdirSync);
    mockReaddir.mockImplementation((base) => {
      if (String(base).includes('Library/Python')) {
        return [
          { name: '3.9', isDirectory: () => true },
          { name: '3.12', isDirectory: () => true },
        ] as unknown as ReturnType<typeof readdirSync>;
      }
      return [] as ReturnType<typeof readdirSync>;
    });

    vi.stubEnv('HOME', '/Users/dev');
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === '/Users/dev/Library/Python/3.9/bin/idb') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error('ENOENT');
    });

    const path = await resolveIdbPath();

    expect(path).toBe('/Users/dev/Library/Python/3.9/bin/idb');
    vi.unstubAllEnvs();
  });

  it('returns empty dirs when Python base dir does not exist', async () => {
    const { readdirSync } = await import('node:fs');
    const mockReaddir = vi.mocked(readdirSync);
    mockReaddir.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    mockExec.mockImplementation(async () => {
      throw new Error('ENOENT');
    });

    await expect(resolveIdbPath()).rejects.toThrow('idb not found');
  });

  it('throws with install instructions when idb is not found anywhere', async () => {
    mockExec.mockImplementation(async () => {
      throw new Error('ENOENT');
    });

    await expect(resolveIdbPath()).rejects.toThrow(
      'Install: brew tap facebook/fb',
    );
  });
});

describe('adb devices non-zero exit', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty when adb devices exits non-zero', async () => {
    mockExec.mockImplementation(async (cmd: string, args?: string[]) => {
      if (cmd === 'xcrun') {
        return { exitCode: 0, stdout: simctlEmpty, stderr: '' };
      }
      if (args?.[0] === 'version') {
        return { exitCode: 0, stdout: '30.0.0', stderr: '' };
      }
      if (args?.[0] === 'devices') {
        return { exitCode: 1, stdout: '', stderr: 'error' };
      }
      throw new Error('ENOENT');
    });

    const devices = await detectAllDevices();

    expect(devices).toStrictEqual([]);
  });
});
