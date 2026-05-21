import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { readSessionFile } from './session-file.js';

const TMP_DIR = join('/tmp', `device-mcp-test-${Date.now()}`);

function writeSession(data: Record<string, unknown>): void {
  writeFileSync(join(TMP_DIR, '.device-session'), JSON.stringify(data));
}

describe('readSessionFile', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
  it('returns null when no file exists', async () => {
    const result = await readSessionFile('/tmp/nonexistent-dir');
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    writeFileSync(join(TMP_DIR, '.device-session'), 'not json');
    const result = await readSessionFile(TMP_DIR);
    expect(result).toBeNull();
  });

  it('parses attach mode with sessionId', async () => {
    writeSession({
      appiumUrl: 'http://localhost:4723',
      sessionId: 'abc-123',
      platform: 'ios',
    });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toStrictEqual({
      mode: 'attach',
      appiumUrl: 'http://localhost:4723',
      sessionId: 'abc-123',
      platform: 'ios',
      auth: undefined,
    });
  });

  it('parses attach mode with auth', async () => {
    writeSession({
      appiumUrl: 'https://hub.browserstack.com/wd/hub',
      sessionId: 'xyz-789',
      platform: 'android',
      auth: { user: 'testuser', key: 'testkey' },
    });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toStrictEqual({
      mode: 'attach',
      appiumUrl: 'https://hub.browserstack.com/wd/hub',
      sessionId: 'xyz-789',
      platform: 'android',
      auth: { user: 'testuser', key: 'testkey' },
    });
  });

  it('parses create mode with capabilities', async () => {
    writeSession({
      appiumUrl: 'https://hub.browserstack.com/wd/hub',
      platform: 'ios',
      capabilities: { platformName: 'iOS', 'appium:deviceName': 'iPhone 15' },
    });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toStrictEqual({
      mode: 'create',
      appiumUrl: 'https://hub.browserstack.com/wd/hub',
      platform: 'ios',
      capabilities: { platformName: 'iOS', 'appium:deviceName': 'iPhone 15' },
      auth: undefined,
    });
  });

  it('rejects missing appiumUrl', async () => {
    writeSession({ sessionId: 'abc', platform: 'ios' });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toBeNull();
  });

  it('rejects invalid platform', async () => {
    writeSession({
      appiumUrl: 'http://localhost:4723',
      sessionId: 'abc',
      platform: 'windows',
    });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toBeNull();
  });

  it('rejects missing sessionId and capabilities', async () => {
    writeSession({
      appiumUrl: 'http://localhost:4723',
      platform: 'ios',
    });
    const result = await readSessionFile(TMP_DIR);
    expect(result).toBeNull();
  });
});
