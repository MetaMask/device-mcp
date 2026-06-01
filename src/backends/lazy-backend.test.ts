import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { DeviceBackend } from './types.js';
import { MultipleDevicesError } from '../utils/platform.js';
import type { DetectedDevice } from '../utils/platform.js';

vi.mock('./session-file.js', () => ({
  readSessionFile: vi.fn().mockResolvedValue(null),
}));

const mockDetectPlatform = vi.fn();
const mockDetectAllDevices = vi.fn();
vi.mock('../utils/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/platform.js')>(
    '../utils/platform.js',
  );
  return {
    ...actual,
    detectPlatform: (...args: unknown[]) => mockDetectPlatform(...args),
    detectAllDevices: (...args: unknown[]) => mockDetectAllDevices(...args),
  };
});

const mockEnsureConnected = vi.fn().mockResolvedValue(undefined);
vi.mock('./idb-backend.js', () => ({
  IdbBackend: vi.fn().mockImplementation((deviceId: string) => ({
    ...createMockBackendFields('ios', deviceId),
    ensureConnected: mockEnsureConnected,
  })),
}));

vi.mock('./adb-backend.js', () => ({
  AdbBackend: vi.fn().mockImplementation((deviceId: string) => ({
    ...createMockBackendFields('android', deviceId),
    ensureConnected: mockEnsureConnected,
  })),
}));

function createMockBackendFields(
  platform: 'ios' | 'android',
  deviceId: string,
): DeviceBackend {
  return {
    platform,
    getDeviceInfo: vi.fn().mockResolvedValue({
      platform,
      deviceId,
      name: platform === 'ios' ? 'Test iPhone' : 'Test Pixel',
      osVersion: platform === 'ios' ? '18.0' : '15',
      state: 'Booted',
    }),
    snapshot: vi.fn().mockResolvedValue({
      platform,
      hierarchy: [],
      raw: '[]',
      timestamp: Date.now(),
    }),
    tapElement: vi.fn().mockResolvedValue({
      success: true,
      x: 50,
      y: 50,
      targetDescription: 'Button',
    }),
    tapCoordinates: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn().mockResolvedValue(undefined),
    waitForElement: vi.fn().mockResolvedValue({
      type: 'Button',
      frame: { x: 0, y: 0, width: 100, height: 44 },
      enabled: true,
    }),
    getAppState: vi.fn().mockResolvedValue({
      bundleId: 'io.metamask',
      state: 'Running',
    }),
    screenshot: vi.fn().mockResolvedValue({
      data: 'base64data',
      format: 'png',
    }),
    openApp: vi.fn().mockResolvedValue(undefined),
    closeApp: vi.fn().mockResolvedValue(undefined),
    pressButton: vi.fn().mockResolvedValue(undefined),
    dismissKeyboard: vi.fn().mockResolvedValue(undefined),
    dismissAlert: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue({ entries: [], source: 'test' }),
    longPress: vi.fn().mockResolvedValue({
      success: true,
      x: 50,
      y: 50,
      targetDescription: 'Button',
    }),
    scrollToElement: vi.fn().mockResolvedValue({
      type: 'Button',
      frame: { x: 0, y: 0, width: 100, height: 44 },
      enabled: true,
    }),
    getAlertText: vi.fn().mockResolvedValue(''),
    getWindowSize: vi.fn().mockResolvedValue({ width: 390, height: 844 }),
    getContexts: vi.fn().mockResolvedValue(['NATIVE_APP']),
    setContext: vi.fn().mockResolvedValue(undefined),
    getClipboard: vi.fn().mockResolvedValue(''),
    setClipboard: vi.fn().mockResolvedValue(undefined),
    startScreenRecording: vi.fn().mockResolvedValue(undefined),
    stopScreenRecording: vi.fn().mockResolvedValue('/tmp/recording.mp4'),
  };
}

describe('createLazyBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function getLazyBackend() {
    const { createLazyBackend } = await import('./index.js');
    return createLazyBackend;
  }

  describe('single device resolution', () => {
    it('defers backend creation until first tool call', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'ios',
        deviceId: 'test-udid',
      });

      const lazy = createLazyBackend();
      expect(mockDetectPlatform).not.toHaveBeenCalled();

      await lazy.getDeviceInfo();
      expect(mockDetectPlatform).toHaveBeenCalledTimes(1);
    });

    it('reuses backend across multiple calls', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'ios',
        deviceId: 'test-udid',
      });

      const lazy = createLazyBackend();

      await lazy.getDeviceInfo();
      await lazy.snapshot();
      await lazy.getAppState('io.metamask');

      expect(mockDetectPlatform).toHaveBeenCalledTimes(1);
    });

    it('passes explicitDeviceId to detectPlatform', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'android',
        deviceId: 'emulator-5554',
      });

      const lazy = createLazyBackend('emulator-5554');
      await lazy.getDeviceInfo();

      expect(mockDetectPlatform).toHaveBeenCalledWith(
        'emulator-5554',
        undefined,
      );
    });

    it('passes explicitPlatform to detectPlatform', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'android',
        deviceId: 'emulator-5554',
      });

      const lazy = createLazyBackend(undefined, 'android');
      await lazy.getDeviceInfo();

      expect(mockDetectPlatform).toHaveBeenCalledWith(undefined, 'android');
    });
  });

  describe('multiple device handling', () => {
    const twoDevices: DetectedDevice[] = [
      { platform: 'ios', deviceId: 'udid-1' },
      { platform: 'ios', deviceId: 'udid-2' },
    ];

    it('throws MultipleDevicesError on first tool call when multiple devices detected', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockRejectedValue(
        new MultipleDevicesError(twoDevices),
      );

      const lazy = createLazyBackend();

      await expect(lazy.getDeviceInfo()).rejects.toThrow(MultipleDevicesError);
    });

    it('throws MultipleDevicesError on subsequent calls without selection', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockRejectedValue(
        new MultipleDevicesError(twoDevices),
      );

      const lazy = createLazyBackend();

      await expect(lazy.snapshot()).rejects.toThrow(MultipleDevicesError);
      await expect(lazy.tapElement({ label: 'x' })).rejects.toThrow(
        MultipleDevicesError,
      );
    });

    it('resolves after selectDevice is called', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform
        .mockRejectedValueOnce(new MultipleDevicesError(twoDevices))
        .mockResolvedValueOnce({
          platform: 'ios',
          deviceId: 'udid-1',
        });

      const lazy = createLazyBackend();

      await expect(lazy.getDeviceInfo()).rejects.toThrow(MultipleDevicesError);

      lazy.selectDevice('udid-1');
      const info = await lazy.getDeviceInfo();

      expect(info.deviceId).toBe('udid-1');
    });

    it('selectDevice clears previous connection state', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'ios',
        deviceId: 'udid-1',
      });

      const lazy = createLazyBackend();
      await lazy.getDeviceInfo();

      expect(mockDetectPlatform).toHaveBeenCalledTimes(1);

      mockDetectPlatform.mockResolvedValue({
        platform: 'android',
        deviceId: 'emulator-5554',
      });

      lazy.selectDevice('emulator-5554');
      await lazy.getDeviceInfo();

      expect(mockDetectPlatform).toHaveBeenCalledTimes(2);
    });
  });

  describe('listDevices', () => {
    const threeDevices: DetectedDevice[] = [
      { platform: 'ios', deviceId: 'udid-1' },
      { platform: 'ios', deviceId: 'udid-2' },
      { platform: 'android', deviceId: 'emulator-5554' },
    ];

    it('returns pending devices when in awaiting-selection state', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockRejectedValue(
        new MultipleDevicesError(threeDevices),
      );

      const lazy = createLazyBackend();

      await expect(lazy.getDeviceInfo()).rejects.toThrow(MultipleDevicesError);

      const devices = await lazy.listDevices();

      expect(devices).toStrictEqual(threeDevices);
      expect(mockDetectAllDevices).not.toHaveBeenCalled();
    });

    it('calls detectAllDevices when not in awaiting-selection state', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectAllDevices.mockResolvedValue(threeDevices);

      const lazy = createLazyBackend();
      const devices = await lazy.listDevices();

      expect(devices).toStrictEqual(threeDevices);
      expect(mockDetectAllDevices).toHaveBeenCalledTimes(1);
    });

    it('passes explicitPlatform filter to detectAllDevices', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectAllDevices.mockResolvedValue([]);

      const lazy = createLazyBackend(undefined, 'ios');
      await lazy.listDevices();

      expect(mockDetectAllDevices).toHaveBeenCalledWith('ios');
    });
  });

  describe('platform getter', () => {
    it('returns ios as default before resolution', async () => {
      const createLazyBackend = await getLazyBackend();
      const lazy = createLazyBackend();

      expect(lazy.platform).toBe('ios');
    });

    it('returns resolved platform after connection', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'android',
        deviceId: 'emulator-5554',
      });

      const lazy = createLazyBackend();
      await lazy.getDeviceInfo();

      expect(lazy.platform).toBe('android');
    });
  });

  describe('error propagation', () => {
    it('propagates non-MultipleDevicesError from createBackend', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockRejectedValue(
        new Error('No connected any device found'),
      );

      const lazy = createLazyBackend();

      await expect(lazy.getDeviceInfo()).rejects.toThrow(
        'No connected any device found',
      );
    });

    it('allows retry after non-multi-device error', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce({
          platform: 'ios',
          deviceId: 'test-udid',
        });

      const lazy = createLazyBackend();

      await expect(lazy.getDeviceInfo()).rejects.toThrow('Temporary failure');

      const info = await lazy.getDeviceInfo();
      expect(info.deviceId).toBe('test-udid');
    });
  });

  describe('delegate methods', () => {
    it('delegates all DeviceBackend methods through resolve', async () => {
      const createLazyBackend = await getLazyBackend();
      mockDetectPlatform.mockResolvedValue({
        platform: 'ios',
        deviceId: 'test-udid',
      });

      const lazy = createLazyBackend();

      await lazy.tapCoordinates(10, 20);
      await lazy.typeText('hello');
      await lazy.swipe('up', 0, 400, 300);
      await lazy.waitForElement({ label: 'Done' }, 5000, 500);
      await lazy.screenshot('/tmp/shot.png');
      await lazy.openApp('io.metamask');
      await lazy.closeApp('io.metamask');
      await lazy.pressButton('home');
      await lazy.dismissKeyboard();
      await lazy.dismissAlert(true);
      await lazy.getLogs(30, 'MetaMask');
      await lazy.longPress({ label: 'hold' }, 2000);
      await lazy.scrollToElement({ label: 'Settings' }, 'down', 5);
      await lazy.getAlertText();
      await lazy.getWindowSize();
      await lazy.getContexts();
      await lazy.setContext('NATIVE_APP');
      await lazy.getClipboard();
      await lazy.setClipboard('copied');
      await lazy.startScreenRecording('/tmp/rec.mp4');
      await lazy.stopScreenRecording();

      expect(mockDetectPlatform).toHaveBeenCalledTimes(1);
    });
  });
});
