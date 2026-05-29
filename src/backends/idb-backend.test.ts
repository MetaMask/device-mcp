import { describe, it, expect, vi, beforeEach } from 'vitest';

import { parseIdbHierarchy, mapIdbElement, IdbBackend } from './idb-backend.js';
import * as execModule from '../utils/exec.js';

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execStrict: vi.fn(),
  isCommandAvailable: vi.fn(),
}));

vi.mock('../utils/platform.js', () => ({
  resolveIdbPath: vi.fn().mockResolvedValue('/usr/local/bin/idb'),
  detectPlatform: vi.fn(),
  detectAllDevices: vi.fn(),
  MultipleDevicesError: class extends Error {},
}));

const mockExec = vi.mocked(execModule.exec);
const mockExecStrict = vi.mocked(execModule.execStrict);

describe('parseIdbHierarchy', () => {
  it('parses a JSON array of elements', () => {
    const raw = JSON.stringify([
      {
        type: 'Button',
        AXLabel: 'Submit',
        frame: { x: 10, y: 20, width: 100, height: 44 },
        enabled: true,
      },
      {
        type: 'TextField',
        AXLabel: 'Password',
        AXValue: '***',
        frame: { x: 10, y: 80, width: 300, height: 44 },
        enabled: true,
      },
    ]);

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('Button');
    expect(result[0].label).toBe('Submit');
    expect(result[1].value).toBe('***');
  });

  it('parses a root object with children', () => {
    const raw = JSON.stringify({
      type: 'Application',
      children: [
        {
          type: 'Window',
          AXLabel: 'Main',
          frame: { x: 0, y: 0, width: 390, height: 844 },
          enabled: true,
        },
      ],
    });

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Window');
    expect(result[0].label).toBe('Main');
  });

  it('parses a single root element without children', () => {
    const raw = JSON.stringify({
      type: 'StaticText',
      AXLabel: 'Hello',
      frame: { x: 50, y: 100, width: 200, height: 30 },
      enabled: true,
    });

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Hello');
  });

  it('returns raw fallback on invalid JSON', () => {
    const result = parseIdbHierarchy('not-json-at-all');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('raw');
    expect(result[0].label).toBe('not-json-at-all');
  });

  it('handles empty JSON array', () => {
    const result = parseIdbHierarchy('[]');
    expect(result).toStrictEqual([]);
  });

  it('parses nested children recursively', () => {
    const raw = JSON.stringify([
      {
        type: 'Window',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        enabled: true,
        children: [
          {
            type: 'Button',
            AXLabel: 'Nested',
            frame: { x: 10, y: 10, width: 50, height: 30 },
            enabled: true,
          },
        ],
      },
    ]);

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children![0].label).toBe('Nested');
  });
});

describe('mapIdbElement', () => {
  it('prefers AX-prefixed fields over plain fields', () => {
    const node = {
      type: 'Button',
      AXType: 'AXButton',
      label: 'plain',
      AXLabel: 'ax-label',
      value: 'plain-val',
      AXValue: 'ax-val',
      identifier: 'plain-id',
      AXUniqueId: 'ax-id',
      frame: { x: 0, y: 0, width: 100, height: 44 },
      enabled: true,
    };

    const result = mapIdbElement(node);
    expect(result.type).toBe('Button');
    expect(result.label).toBe('ax-label');
    expect(result.value).toBe('ax-val');
    expect(result.identifier).toBe('ax-id');
  });

  it('falls back to plain fields when AX fields are missing', () => {
    const node = {
      type: 'TextField',
      label: 'Email',
      value: 'test@example.com',
      identifier: 'email-input',
      frame: { x: 10, y: 20, width: 300, height: 44 },
      enabled: false,
    };

    const result = mapIdbElement(node);
    expect(result.label).toBe('Email');
    expect(result.value).toBe('test@example.com');
    expect(result.identifier).toBe('email-input');
    expect(result.enabled).toBe(false);
  });

  it('defaults frame to zeros when missing', () => {
    const node = { type: 'Other' };
    const result = mapIdbElement(node);
    expect(result.frame).toStrictEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('defaults type to Unknown when missing', () => {
    const node = { frame: { x: 0, y: 0, width: 10, height: 10 } };
    const result = mapIdbElement(node);
    expect(result.type).toBe('Unknown');
  });
});

describe('IdbBackend simctl fallback', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  describe('openApp', () => {
    it('uses idb launch when it succeeds', async () => {
      mockExecStrict.mockResolvedValue('');

      await backend.openApp('io.metamask');

      expect(mockExecStrict).toHaveBeenCalledWith('/usr/local/bin/idb', [
        'launch',
        'io.metamask',
        '--udid',
        udid,
      ]);
      expect(mockExecStrict).toHaveBeenCalledTimes(1);
    });

    it('falls back to simctl launch when idb fails', async () => {
      mockExecStrict
        .mockRejectedValueOnce(new Error('companion conflict'))
        .mockResolvedValueOnce('');

      await backend.openApp('io.metamask');

      expect(mockExecStrict).toHaveBeenCalledTimes(2);
      expect(mockExecStrict).toHaveBeenLastCalledWith('xcrun', [
        'simctl',
        'launch',
        udid,
        'io.metamask',
      ]);
    });
  });

  describe('closeApp', () => {
    it('uses idb terminate when it succeeds', async () => {
      mockExecStrict.mockResolvedValue('');

      await backend.closeApp('io.metamask');

      expect(mockExecStrict).toHaveBeenCalledWith('/usr/local/bin/idb', [
        'terminate',
        'io.metamask',
        '--udid',
        udid,
      ]);
    });

    it('falls back to simctl terminate when idb fails', async () => {
      mockExecStrict
        .mockRejectedValueOnce(new Error('companion conflict'))
        .mockResolvedValueOnce('');

      await backend.closeApp('io.metamask');

      expect(mockExecStrict).toHaveBeenLastCalledWith('xcrun', [
        'simctl',
        'terminate',
        udid,
        'io.metamask',
      ]);
    });
  });

  describe('getAppState', () => {
    it('uses idb list-apps when it succeeds', async () => {
      mockExecStrict.mockResolvedValue(
        'io.metamask | MetaMask | Running | 12345\n',
      );

      const result = await backend.getAppState('io.metamask');

      expect(result).toStrictEqual({
        bundleId: 'io.metamask',
        state: 'Running',
        pid: 12345,
      });
    });

    it('falls back to simctl listapps when idb fails', async () => {
      mockExecStrict.mockRejectedValue(new Error('companion conflict'));
      mockExec.mockImplementation(async (cmd) => {
        if (cmd === 'xcrun') {
          return {
            exitCode: 0,
            stdout: 'CFBundleIdentifier = "io.metamask"',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const result = await backend.getAppState('io.metamask');

      expect(result).toStrictEqual({
        bundleId: 'io.metamask',
        state: 'Running',
      });
    });

    it('returns Not Installed when simctl fallback finds no match', async () => {
      mockExecStrict.mockRejectedValue(new Error('companion conflict'));
      mockExec.mockResolvedValue({
        exitCode: 0,
        stdout: 'CFBundleIdentifier = "com.apple.Maps"',
        stderr: '',
      });

      const result = await backend.getAppState('io.metamask');

      expect(result).toStrictEqual({
        bundleId: 'io.metamask',
        state: 'Not Installed',
      });
    });
  });
});
