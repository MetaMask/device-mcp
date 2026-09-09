import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { parseIdbHierarchy, mapIdbElement, IdbBackend } from './idb-backend.js';
import * as execModule from '../utils/exec.js';
import * as platformModule from '../utils/platform.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execStrict: vi.fn(),
  isCommandAvailable: vi.fn(),
}));

vi.mock('../utils/platform.js', () => ({
  resolveIdbPath: vi.fn().mockResolvedValue('/usr/local/bin/idb'),
  idbSupportsApiSelection: vi.fn().mockResolvedValue(false),
  chooseAxApi: vi.fn().mockReturnValue(null),
  detectPlatform: vi.fn(),
  detectAllDevices: vi.fn(),
  MultipleDevicesError: class extends Error {},
}));

const mockExec = vi.mocked(execModule.exec);
const mockExecStrict = vi.mocked(execModule.execStrict);
const mockReadFile = vi.mocked(readFile);
const mockSupportsApi = vi.mocked(platformModule.idbSupportsApiSelection);
const mockChooseAxApi = vi.mocked(platformModule.chooseAxApi);

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

describe('IdbBackend.kind', () => {
  it('is the stable "idb" discriminator', () => {
    expect(new IdbBackend('AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF').kind).toBe(
      'idb',
    );
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
    it('parses real idb list-apps output when the app is running', async () => {
      mockExecStrict.mockResolvedValue(
        'io.metamask.MetaMask | MetaMask | user | x86_64, arm64 | Running | Not Debuggable | pid=33355\n',
      );

      const result = await backend.getAppState('io.metamask');

      expect(result).toStrictEqual({
        bundleId: 'io.metamask',
        state: 'Running',
        pid: 33355,
      });
    });

    it('omits pid and reports the process state for a stopped app', async () => {
      mockExecStrict.mockResolvedValue(
        'io.metamask.MetaMask | MetaMask | user | x86_64, arm64 | Not running | Not Debuggable | pid=None\n',
      );

      const result = await backend.getAppState('io.metamask');

      expect(result).toStrictEqual({
        bundleId: 'io.metamask',
        state: 'Not running',
        pid: undefined,
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

  describe('getElementText', () => {
    it('returns label from matching element', async () => {
      const hierarchy = [
        {
          type: 'StaticText',
          AXLabel: 'Balance',
          AXValue: '$100.00',
          frame: { x: 0, y: 0, width: 200, height: 30 },
          enabled: true,
        },
      ];
      mockExecStrict.mockResolvedValue(JSON.stringify(hierarchy));

      const text = await backend.getElementText({ label: 'Balance' });

      expect(text).toBe('Balance');
    });

    it('returns value when label is missing', async () => {
      const hierarchy = [
        {
          type: 'TextField',
          AXValue: 'typed text',
          frame: { x: 0, y: 0, width: 200, height: 44 },
          enabled: true,
        },
      ];
      mockExecStrict.mockResolvedValue(JSON.stringify(hierarchy));

      const text = await backend.getElementText({ type: 'TextField' });

      expect(text).toBe('typed text');
    });

    it('throws when element is not found', async () => {
      mockExecStrict.mockResolvedValue(JSON.stringify([]));

      await expect(
        backend.getElementText({ identifier: 'nonexistent' }),
      ).rejects.toThrow('Element not found');
    });
  });
});

describe('IdbBackend.screenshot', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('captures with idb and encodes base64 in-process by default', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('ZmFrZS1wbmc=');

    const result = await backend.screenshot('/tmp/shot.png');

    expect(mockExecStrict).toHaveBeenCalledWith('/usr/local/bin/idb', [
      'screenshot',
      '/tmp/shot.png',
      '--udid',
      udid,
    ]);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/shot.png', 'base64');
    expect(result).toStrictEqual({
      data: 'ZmFrZS1wbmc=',
      format: 'png',
      path: '/tmp/shot.png',
    });
  });

  it('never shells out to the non-portable base64 binary', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('Zm9v');

    await backend.screenshot('/tmp/shot.png');

    expect(mockExecStrict).not.toHaveBeenCalledWith(
      'base64',
      expect.anything(),
    );
  });

  it('skips base64 encoding when encode is false', async () => {
    mockExecStrict.mockResolvedValue('');

    const result = await backend.screenshot('/tmp/shot.png', { encode: false });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      data: undefined,
      format: 'png',
      path: '/tmp/shot.png',
    });
  });

  it('defaults to a tmp path when none is provided', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('YmFy');

    const result = await backend.screenshot();

    expect(result.path).toMatch(
      /[/\\]device-mcp-[^/\\]+[/\\]screenshot-[0-9a-f]{16}\.png$/u,
    );
    expect(result.data).toBe('YmFy');
  });
});

describe('IdbBackend.swipe and getWindowSize', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  /** iPhone 16 Pro geometry: pixels 1206x2622, logical points 402x874. */
  const screenInfo = {
    os_version: '26.5',
    screen_dimensions: {
      width: 1206,
      height: 2622,
      density: 3.0,
      width_points: 402,
      height_points: 874,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('prefers logical point dimensions over hardware pixels', async () => {
    mockExecStrict.mockResolvedValue(JSON.stringify(screenInfo));

    expect(await backend.getWindowSize()).toStrictEqual({
      width: 402,
      height: 874,
    });
  });

  it('falls back to the snapshot root frame when describe lacks dimensions', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '26.5' });
      }
      return JSON.stringify([
        {
          type: 'Application',
          frame: { x: 0, y: 0, width: 402, height: 874 },
          enabled: true,
        },
      ]);
    });

    expect(await backend.getWindowSize()).toStrictEqual({
      width: 402,
      height: 874,
    });
  });

  it('sends a centered default swipe with an explicit duration', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify([]);
    });

    await backend.swipe('up');

    // start: (round(402/2), round(874/2)) = (201, 437);
    // distance: round(874 * 0.4) = 350 -> end y = 87.
    expect(mockExecStrict).toHaveBeenCalledWith('/usr/local/bin/idb', [
      'ui',
      'swipe',
      '201',
      '437',
      '201',
      '87',
      '--duration',
      '0.3',
      '--udid',
      udid,
    ]);
  });

  it('keeps a computed default endpoint inside the viewport', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify([]);
    });

    // An explicit start near the top edge leaves little room for an up swipe.
    await backend.swipe('up', 201, 100);

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['201', '100', '201', '1']),
    );
  });

  it('leaves explicitly provided endpoints untouched', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify([]);
    });

    await backend.swipe('up', 200, 400, 500);

    // The shipped 0.3.3 geometry, preserved when the caller pins it.
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['200', '400', '200', '-100']),
    );
  });

  it('centers horizontal default swipes on the width axis', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify([]);
    });

    await backend.swipe('left');

    // distance: round(402 * 0.4) = 161 -> end x = 201 - 161 = 40.
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['201', '437', '40', '437']),
    );
  });
});

describe('IdbBackend.tapElement and longPress viewport handling', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  const screenInfo = {
    os_version: '26.5',
    screen_dimensions: {
      width: 1206,
      height: 2622,
      density: 3.0,
      width_points: 402,
      height_points: 874,
    },
  };

  const mockScreen = (hierarchy: Record<string, unknown>[]): void => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify(hierarchy);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('taps the frame center when the element is fully visible', async () => {
    mockScreen([
      {
        type: 'Button',
        AXLabel: 'Submit',
        identifier: 'submit-btn',
        frame: { x: 10, y: 20, width: 100, height: 44 },
        enabled: true,
      },
    ]);

    const result = await backend.tapElement({ identifier: 'submit-btn' });

    expect(result).toMatchObject({ x: 60, y: 42 });
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['ui', 'tap', '60', '42']),
    );
  });

  it('taps the center of the visible part of a partially scrolled element', async () => {
    mockScreen([
      {
        type: 'Button',
        AXLabel: 'Peek',
        identifier: 'peek-btn',
        frame: { x: 0, y: 800, width: 402, height: 150 },
        enabled: true,
      },
    ]);

    const result = await backend.tapElement({ identifier: 'peek-btn' });

    // Visible intersection is y 800..874 -> center y = 837.
    expect(result).toMatchObject({ x: 201, y: 837 });
  });

  it('throws a viewport diagnostic instead of tapping off-screen', async () => {
    mockScreen([
      {
        type: 'Button',
        AXLabel: 'Hidden',
        identifier: 'hidden-btn',
        frame: { x: 0, y: 1000, width: 402, height: 100 },
        enabled: true,
      },
    ]);

    await expect(
      backend.tapElement({ identifier: 'hidden-btn' }),
    ).rejects.toThrow('outside the 402x874 viewport');
    expect(mockExecStrict).not.toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['ui', 'tap']),
    );
  });

  it('applies the same viewport check to longPress', async () => {
    mockScreen([
      {
        type: 'Button',
        AXLabel: 'Hidden',
        identifier: 'hidden-btn',
        frame: { x: 0, y: 1000, width: 402, height: 100 },
        enabled: true,
      },
    ]);

    await expect(
      backend.longPress({ identifier: 'hidden-btn' }),
    ).rejects.toThrow('outside the 402x874 viewport');
  });
});

describe('IdbBackend.ensureConnected', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('connects and enables the simulator accessibility bridge', async () => {
    await backend.ensureConnected();

    expect(mockExec).toHaveBeenCalledWith('/usr/local/bin/idb', [
      'connect',
      udid,
    ]);
    expect(mockExec).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'spawn',
      udid,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ApplicationAccessibilityEnabled',
      '-bool',
      'true',
    ]);
  });

  it('enables accessibility only once across repeated calls', async () => {
    await backend.ensureConnected();
    await backend.ensureConnected();

    const axCalls = mockExec.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'xcrun' && args.includes('ApplicationAccessibilityEnabled'),
    );
    expect(axCalls).toHaveLength(1);
  });

  it('still connects when enabling accessibility fails', async () => {
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === 'xcrun') {
        throw new Error('defaults write not permitted');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    expect(await backend.ensureConnected()).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith('/usr/local/bin/idb', [
      'connect',
      udid,
    ]);
  });
});

describe('IdbBackend.snapshot accessibility backend selection', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  const describeArgs = (extra: string[] = []): string[] => [
    'ui',
    'describe-all',
    '--udid',
    udid,
    ...extra,
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('omits --api when the CLI does not support it', async () => {
    mockSupportsApi.mockResolvedValue(false);
    mockExecStrict.mockResolvedValue(JSON.stringify([]));

    await backend.snapshot();

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(),
    );
    expect(mockExecStrict).not.toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['--api']),
    );
  });

  it('uses the version-chosen --api backend when supported', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    // getDeviceInfo() -> describe --json, then describe-all --api axbridge
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '26.1', name: 'iPhone' });
      }
      return JSON.stringify([]);
    });

    await backend.snapshot();

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'axbridge']),
    );
  });

  it('falls back to the complementary backend when the preferred errors', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '17.4', name: 'iPhone' });
      }
      if (args?.includes('axbridge')) {
        throw new Error('axbridge backend requested accessibility failed');
      }
      return JSON.stringify([]);
    });

    await backend.snapshot();

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'axbridge']),
    );
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'ax']),
    );
  });

  it('throws when every backend fails', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '26.1', name: 'iPhone' });
      }
      throw new Error('No translation object returned for simulator');
    });

    await expect(backend.snapshot()).rejects.toThrow(
      'No translation object returned for simulator',
    );
  });

  it('orders ax first then axbridge on iOS <= 17', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('ax');
    const seen: string[] = [];
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '17.4', name: 'iPhone' });
      }
      const apiIndex = args?.indexOf('--api') ?? -1;
      if (apiIndex >= 0 && args) {
        seen.push(args[apiIndex + 1]);
      }
      // ax succeeds immediately on the older runtime.
      return JSON.stringify([]);
    });

    await backend.snapshot();

    // Only the preferred (ax) should have run; complement not needed.
    expect(seen).toStrictEqual(['ax']);
  });

  it('tries ax then axbridge when ax errors on an unknown-order device', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('ax');
    const seen: string[] = [];
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '17.4', name: 'iPhone' });
      }
      const apiIndex = args?.indexOf('--api') ?? -1;
      const api = apiIndex >= 0 && args ? args[apiIndex + 1] : 'none';
      seen.push(api);
      if (api === 'ax') {
        throw new Error('ax backend unavailable');
      }
      return JSON.stringify([]);
    });

    await backend.snapshot();

    expect(seen).toStrictEqual(['ax', 'axbridge']);
  });

  it('rethrows a non-Error rejection as a descriptive Error', async () => {
    mockSupportsApi.mockResolvedValue(false);
    mockExecStrict.mockRejectedValue('boom');

    await expect(backend.snapshot()).rejects.toThrow(
      'idb ui describe-all failed for all accessibility backends',
    );
  });
});
