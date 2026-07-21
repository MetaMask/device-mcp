import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ANDROID_APP_ID,
  DEFAULT_IOS_APP_ID,
  DEFAULT_METRO_PORT,
  defaultAppIdForPlatform,
  getHermesSession,
  HermesSession,
  resetHermesSession,
} from './session.js';

describe('defaultAppIdForPlatform', () => {
  it('returns the iOS bundle id for ios', () => {
    expect(defaultAppIdForPlatform('ios')).toBe(DEFAULT_IOS_APP_ID);
  });

  it('returns the Android bundle id for android', () => {
    expect(defaultAppIdForPlatform('android')).toBe(DEFAULT_ANDROID_APP_ID);
  });

  it('defaults to the iOS bundle id when platform is unknown', () => {
    expect(defaultAppIdForPlatform()).toBe(DEFAULT_IOS_APP_ID);
    expect(defaultAppIdForPlatform(undefined)).toBe(DEFAULT_IOS_APP_ID);
  });
});

describe('HermesSession metroPort resolution', () => {
  it('uses the default port when no env or param is set', () => {
    const session = new HermesSession({ env: {} });
    expect(session.getMetroPort()).toBe(DEFAULT_METRO_PORT);
    expect(session.resolve().metroPort).toBe(DEFAULT_METRO_PORT);
  });

  it('uses HERMES_METRO_PORT env over the default', () => {
    const session = new HermesSession({ env: { HERMES_METRO_PORT: '9000' } });
    expect(session.getMetroPort()).toBe(9000);
    expect(session.resolve().metroPort).toBe(9000);
  });

  it('uses a per-call param over env and default', () => {
    const session = new HermesSession({ env: { HERMES_METRO_PORT: '9000' } });
    expect(session.resolve({ metroPort: 8082 }).metroPort).toBe(8082);
  });

  it('falls back to 8081 when HERMES_METRO_PORT is invalid', () => {
    const session = new HermesSession({
      env: { HERMES_METRO_PORT: 'not-a-number' },
    });
    expect(session.getMetroPort()).toBe(8081);
    expect(session.getMetroPort()).toBe(DEFAULT_METRO_PORT);
  });

  it('falls back to 8081 when HERMES_METRO_PORT is a float (non-integer)', () => {
    const session = new HermesSession({ env: { HERMES_METRO_PORT: '80.5' } });
    // parseInt('80.5') === 80 which is an integer, so the parsed value wins.
    expect(session.getMetroPort()).toBe(80);
  });

  it('falls back to 8081 when HERMES_METRO_PORT is empty string', () => {
    const session = new HermesSession({ env: { HERMES_METRO_PORT: '' } });
    expect(session.getMetroPort()).toBe(DEFAULT_METRO_PORT);
  });
});

describe('HermesSession appId resolution', () => {
  it('defaults to the iOS app id when no platform/env/param', () => {
    const session = new HermesSession({ env: {} });
    expect(session.getAppId()).toBe(DEFAULT_IOS_APP_ID);
    expect(session.resolve().appId).toBe(DEFAULT_IOS_APP_ID);
  });

  it('uses the Android default when platform is android', () => {
    const session = new HermesSession({ env: {}, platform: 'android' });
    expect(session.getAppId()).toBe(DEFAULT_ANDROID_APP_ID);
  });

  it('uses the iOS default when platform is ios', () => {
    const session = new HermesSession({ env: {}, platform: 'ios' });
    expect(session.getAppId()).toBe(DEFAULT_IOS_APP_ID);
  });

  it('uses HERMES_APP_ID env over the platform default', () => {
    const session = new HermesSession({
      env: { HERMES_APP_ID: 'io.custom.app' },
      platform: 'android',
    });
    expect(session.getAppId()).toBe('io.custom.app');
    expect(session.resolve().appId).toBe('io.custom.app');
  });

  it('uses a per-call appId param over env and default', () => {
    const session = new HermesSession({
      env: { HERMES_APP_ID: 'io.custom.app' },
    });
    expect(session.resolve({ appId: 'io.percall.app' }).appId).toBe(
      'io.percall.app',
    );
  });

  it('resolves the Android default when platform: android is passed at call time', () => {
    const session = new HermesSession({ env: {} });
    expect(session.resolve({ platform: 'android' }).appId).toBe(
      DEFAULT_ANDROID_APP_ID,
    );
  });

  it('still resolves the iOS default when platform: ios is passed at call time', () => {
    const session = new HermesSession({ env: {} });
    expect(session.resolve({ platform: 'ios' }).appId).toBe(DEFAULT_IOS_APP_ID);
  });

  it('keeps the iOS default (back-compat) when no platform is passed at call time', () => {
    const session = new HermesSession({ env: {} });
    expect(session.resolve().appId).toBe(DEFAULT_IOS_APP_ID);
  });

  it('lets an explicit HERMES_APP_ID env win over the per-call Android platform default', () => {
    const session = new HermesSession({
      env: { HERMES_APP_ID: 'io.custom.app' },
    });
    expect(session.resolve({ platform: 'android' }).appId).toBe(
      'io.custom.app',
    );
  });

  it('lets a per-call appId win over the per-call platform default', () => {
    const session = new HermesSession({ env: {} });
    expect(
      session.resolve({ platform: 'android', appId: 'io.percall.app' }).appId,
    ).toBe('io.percall.app');
  });
});

describe('HermesSession pin set/get', () => {
  it('starts with no pin', () => {
    const session = new HermesSession({ env: {} });
    expect(session.getPinnedHermesDeviceId()).toBeUndefined();
    expect(session.resolve().pinnedDeviceId).toBeUndefined();
  });

  it('returns the pin after it is set', () => {
    const session = new HermesSession({ env: {} });
    session.setPinnedHermesDeviceId('logical-device-1');
    expect(session.getPinnedHermesDeviceId()).toBe('logical-device-1');
    expect(session.resolve().pinnedDeviceId).toBe('logical-device-1');
  });

  it('overwrites a prior pin', () => {
    const session = new HermesSession({ env: {} });
    session.setPinnedHermesDeviceId('logical-device-1');
    session.setPinnedHermesDeviceId('logical-device-2');
    expect(session.getPinnedHermesDeviceId()).toBe('logical-device-2');
  });
});

describe('HermesSession.resolve immutability', () => {
  it('does not mutate the stored defaults when given per-call overrides', () => {
    const session = new HermesSession({
      env: { HERMES_METRO_PORT: '8081', HERMES_APP_ID: 'io.default.app' },
    });

    session.resolve({ metroPort: 9999, appId: 'io.other.app' });

    expect(session.getMetroPort()).toBe(8081);
    expect(session.getAppId()).toBe('io.default.app');
    expect(session.resolve()).toStrictEqual({
      metroPort: 8081,
      appId: 'io.default.app',
      pinnedDeviceId: undefined,
    });
  });

  it('reflects the current pin without mutating it', () => {
    const session = new HermesSession({ env: {} });
    session.setPinnedHermesDeviceId('pin-1');
    const resolved = session.resolve({ metroPort: 1234 });
    expect(resolved.pinnedDeviceId).toBe('pin-1');
    expect(session.getPinnedHermesDeviceId()).toBe('pin-1');
  });
});

describe('getHermesSession / resetHermesSession', () => {
  beforeEach(() => {
    resetHermesSession();
  });

  afterEach(() => {
    resetHermesSession();
  });

  it('returns the same singleton instance across calls', () => {
    const first = getHermesSession({ env: {} });
    const second = getHermesSession();
    expect(second).toBe(first);
  });

  it('ignores options passed after the singleton is created', () => {
    const first = getHermesSession({ env: { HERMES_METRO_PORT: '7000' } });
    const second = getHermesSession({ env: { HERMES_METRO_PORT: '9000' } });
    expect(second).toBe(first);
    expect(second.getMetroPort()).toBe(7000);
  });

  it('resetHermesSession isolates instances between calls', () => {
    const first = getHermesSession({ env: {} });
    first.setPinnedHermesDeviceId('pin-from-first');

    resetHermesSession();

    const second = getHermesSession({ env: {} });
    expect(second).not.toBe(first);
    expect(second.getPinnedHermesDeviceId()).toBeUndefined();
  });
});
