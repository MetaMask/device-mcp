import { describe, it, expect, vi } from 'vitest';

import type { DeviceBackend } from './types.js';

function createMockBackend(): DeviceBackend {
  return {
    platform: 'ios',
    getDeviceInfo: vi.fn().mockResolvedValue({
      platform: 'ios',
      deviceId: 'test-udid',
      name: 'Test iPhone',
      osVersion: '18.0',
      state: 'Booted',
    }),
    snapshot: vi.fn().mockResolvedValue({
      platform: 'ios',
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
  };
}

class LazyWrapper {
  #inner: DeviceBackend | null = null;

  readonly #factory: () => Promise<DeviceBackend>;

  constructor(factory: () => Promise<DeviceBackend>) {
    this.#factory = factory;
  }

  async resolve(): Promise<DeviceBackend> {
    if (!this.#inner) {
      this.#inner = await this.#factory();
    }
    return this.#inner;
  }
}

describe('lazy backend pattern', () => {
  it('defers backend creation until first call', async () => {
    const mockBackend = createMockBackend();
    const factory = vi.fn().mockResolvedValue(mockBackend);
    const lazy = new LazyWrapper(factory);

    expect(factory).not.toHaveBeenCalled();

    const backend = await lazy.resolve();
    await backend.getDeviceInfo();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(mockBackend.getDeviceInfo).toHaveBeenCalledTimes(1);
  });

  it('reuses the same backend across multiple calls', async () => {
    const mockBackend = createMockBackend();
    const factory = vi.fn().mockResolvedValue(mockBackend);
    const lazy = new LazyWrapper(factory);

    await (await lazy.resolve()).getDeviceInfo();
    await (await lazy.resolve()).snapshot();
    await (await lazy.resolve()).getAppState('io.metamask');

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('propagates backend creation errors', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('No device found'));
    const lazy = new LazyWrapper(factory);

    await expect(lazy.resolve()).rejects.toThrow('No device found');
  });

  it('delegates all backend methods', async () => {
    const mockBackend = createMockBackend();
    const lazy = new LazyWrapper(async () => mockBackend);
    const backend = await lazy.resolve();

    await backend.getDeviceInfo();
    await backend.snapshot();
    await backend.tapElement({ label: 'test' });
    await backend.tapCoordinates(10, 20);
    await backend.typeText('hello');
    await backend.swipe('up');
    await backend.waitForElement({ label: 'test' });
    await backend.getAppState('io.metamask');
    await backend.screenshot();
    await backend.openApp('io.metamask');
    await backend.closeApp('io.metamask');
    await backend.pressButton('home');
    await backend.dismissKeyboard();
    await backend.dismissAlert(true);
    await backend.getLogs();
    await backend.longPress({ label: 'test' });

    expect(mockBackend.getDeviceInfo).toHaveBeenCalled();
    expect(mockBackend.snapshot).toHaveBeenCalled();
    expect(mockBackend.tapElement).toHaveBeenCalled();
    expect(mockBackend.tapCoordinates).toHaveBeenCalled();
    expect(mockBackend.typeText).toHaveBeenCalled();
    expect(mockBackend.swipe).toHaveBeenCalled();
    expect(mockBackend.waitForElement).toHaveBeenCalled();
    expect(mockBackend.getAppState).toHaveBeenCalled();
    expect(mockBackend.screenshot).toHaveBeenCalled();
    expect(mockBackend.openApp).toHaveBeenCalled();
    expect(mockBackend.closeApp).toHaveBeenCalled();
    expect(mockBackend.pressButton).toHaveBeenCalled();
    expect(mockBackend.dismissKeyboard).toHaveBeenCalled();
    expect(mockBackend.dismissAlert).toHaveBeenCalled();
    expect(mockBackend.getLogs).toHaveBeenCalled();
    expect(mockBackend.longPress).toHaveBeenCalled();
  });
});
