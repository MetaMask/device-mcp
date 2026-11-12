import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseIdbHierarchy, mapIdbElement, IdbBackend } from './idb-backend.js';
import { IdbUnavailableError } from './idb-errors.js';
import type { UIElement } from './types.js';
import { findElement, generateLocators } from '../utils/element.js';
import * as execModule from '../utils/exec.js';
import { TargetObscuredError } from '../utils/hit-test.js';
import * as platformModule from '../utils/platform.js';

const connectionMocks = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
}));
const connectionState = vi.hoisted(() => ({ alive: true }));
vi.mock('./idb-connection.js', () => ({
  IdbConnection: vi.fn().mockImplementation(function mockIdbConnection() {
    return {
      ...connectionMocks,
      get alive(): boolean {
        return connectionState.alive;
      },
      env: { IDB_COMPANION: '/tmp/private-companion.sock' },
    };
  }),
}));
const connectionOptions = {
  env: { IDB_COMPANION: '/tmp/private-companion.sock' },
};

vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));

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
  idbSupportsNestedDescribe: vi.fn().mockResolvedValue(false),
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
const mockSupportsNested = vi.mocked(platformModule.idbSupportsNestedDescribe);

describe('parseIdbHierarchy', () => {
  it('treats an empty children array on a root object as a leaf', () => {
    const result = parseIdbHierarchy(
      JSON.stringify({ type: 'Application', AXLabel: 'App', children: [] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('App');
    expect(result[0].children).toBeUndefined();
  });

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

describe('parseIdbHierarchy with synthetic flat and nested fixtures', () => {
  // Synthetic idb output: only fields consumed by the mapper are included.
  const fixture = (name: string): string =>
    readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  const flat = parseIdbHierarchy(fixture('idb-describe-all-login-flat.json'));
  const nested = parseIdbHierarchy(
    fixture('idb-describe-all-login-nested.json'),
  );

  const walk = (elements: UIElement[]): UIElement[] =>
    elements.flatMap((el) => [el, ...walk(el.children ?? [])]);
  const withoutChildren = (el: UIElement): UIElement => ({
    ...el,
    children: undefined,
  });
  const locatorKeys = (elements: UIElement[]): string[] =>
    generateLocators(elements)
      .map((loc) => loc.description)
      .sort();

  it('preserves tree shape and maps both formats identically in pre-order', () => {
    expect(flat.every((el) => el.children === undefined)).toBe(true);
    expect(nested).toHaveLength(1);
    expect(nested[0].type).toBe('Application');
    expect(flat).toHaveLength(19);
    expect(walk(nested).map(withoutChildren)).toStrictEqual(flat);
  });

  it('yields the same actionable elements from both formats', () => {
    expect(locatorKeys(nested)).toStrictEqual(locatorKeys(flat));
    expect(locatorKeys(nested)).toStrictEqual(
      expect.arrayContaining([
        'SecureTextField label="Password" id="login-password-input"',
        'Button label="Unlock" id="log-in-button"',
        'Button label="Enable" id="login-info-modal-enable-button"',
        'Button label="Not now" id="login-info-modal-dismiss-button"',
      ]),
    );
    for (const query of [
      { identifier: 'login-password-input' },
      { label: 'Unlock' },
      { identifier: 'login-info-modal-dismiss-button' },
    ]) {
      expect(findElement(nested, query)).toStrictEqual(
        findElement(flat, query),
      );
    }
  });

  it('keeps the modal buttons as descendants of the modal container', () => {
    const modal = findElement(nested, { identifier: 'login-info-modal' });

    expect(modal).not.toBeNull();
    const inModal = walk(modal?.children ?? []);
    expect(inModal.map((el) => el.identifier).filter(Boolean)).toStrictEqual([
      'login-info-modal-enable-button',
      'login-info-modal-dismiss-button',
    ]);
    expect(inModal.map((el) => el.label)).toContain('Unlock with Face ID?');
    expect(
      findElement(modal?.children ?? [], { identifier: 'log-in-button' }),
    ).toBeNull();
  });

  it('places the password field under the login screen container', () => {
    const login = findElement(nested, { identifier: 'login' });

    expect(
      findElement(login?.children ?? [], {
        identifier: 'login-password-input',
      }),
    ).not.toBeNull();
    expect(
      findElement(login?.children ?? [], { identifier: 'log-in-button' })
        ?.enabled,
    ).toBe(false);
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

  it('maps an empty children array (nested-format leaf) to undefined', () => {
    const result = mapIdbElement({ type: 'Button', children: [] });
    expect(result.children).toBeUndefined();
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

      expect(mockExecStrict).toHaveBeenCalledWith(
        '/usr/local/bin/idb',
        ['launch', 'io.metamask', '--udid', udid],
        connectionOptions,
      );
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

      expect(mockExecStrict).toHaveBeenCalledWith(
        '/usr/local/bin/idb',
        ['terminate', 'io.metamask', '--udid', udid],
        connectionOptions,
      );
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

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      ['screenshot', '/tmp/shot.png', '--udid', udid],
      connectionOptions,
    );
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
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      [
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
      ],
      connectionOptions,
    );
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
      connectionOptions,
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
      connectionOptions,
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
      connectionOptions,
    );
  });

  it('reuses the window size while scrolling to an element', async () => {
    let snapshotCount = 0;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      if (args?.includes('describe-all')) {
        snapshotCount += 1;
        return JSON.stringify([
          {
            type: snapshotCount >= 3 ? 'Button' : 'StaticText',
            AXLabel: snapshotCount >= 3 ? 'Settings' : `Page ${snapshotCount}`,
            frame: { x: 10, y: 200, width: 100, height: 44 },
            enabled: true,
          },
        ]);
      }
      return '';
    });

    await backend.scrollToElement({ label: 'Settings' });

    const describeCalls = mockExecStrict.mock.calls.filter(([, args]) =>
      args?.includes('describe'),
    );
    expect(describeCalls).toHaveLength(1);
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
      connectionOptions,
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
      connectionOptions,
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

  it('takes one snapshot for a caller-resolved element when none is stored', async () => {
    mockScreen([]);

    const result = await backend.tapElement(
      { identifier: 'submit-btn' },
      {
        element: {
          type: 'Button',
          identifier: 'submit-btn',
          frame: { x: 10, y: 20, width: 100, height: 44 },
          enabled: true,
        },
      },
    );

    expect(result).toMatchObject({ success: true, x: 60, y: 42 });
    const describeAll = mockExecStrict.mock.calls.filter(([, args]) =>
      args?.includes('describe-all'),
    );
    expect(describeAll).toHaveLength(1);
  });

  it('keeps the viewport check for a caller-resolved element', async () => {
    mockScreen([]);

    await expect(
      backend.tapElement(
        { identifier: 'hidden-btn' },
        {
          element: {
            type: 'Button',
            identifier: 'hidden-btn',
            frame: { x: 0, y: 1000, width: 402, height: 100 },
            enabled: true,
          },
        },
      ),
    ).rejects.toThrow('outside the 402x874 viewport');
  });
});

describe('IdbBackend tap hit-test', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  const loginButton: UIElement = {
    type: 'Button',
    label: 'Unlock',
    identifier: 'log-in-button',
    frame: { x: 16.3, y: 532.3, width: 369.3, height: 48 },
    enabled: true,
  };

  /**
   * @param hit - What `describe-point` returns: a node, an error, or raw text.
   * @param hierarchy - What `describe-all` returns, when the test taps by query.
   * @param screen - The window size `idb describe` reports, in points.
   * @param screen.widthPoints - Window width in points.
   * @param screen.heightPoints - Window height in points.
   */
  const mockDevice = (
    hit: Record<string, unknown> | Error | string,
    hierarchy: Record<string, unknown>[] = [],
    screen: { widthPoints: number; heightPoints: number } = {
      widthPoints: 402,
      heightPoints: 874,
    },
  ): void => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.[0] === 'describe' && args.includes('--json')) {
        return JSON.stringify({
          os_version: '26.5',
          screen_dimensions: {
            width_points: screen.widthPoints,
            height_points: screen.heightPoints,
          },
        });
      }
      if (args?.[1] === 'describe-all') {
        return JSON.stringify(hierarchy);
      }
      if (args?.[1] === 'describe-point') {
        if (hit instanceof Error) {
          throw hit;
        }
        return typeof hit === 'string' ? hit : JSON.stringify(hit);
      }
      return '';
    });
  };

  const tapCalls = (): unknown[][] =>
    mockExecStrict.mock.calls.filter(([, args]) => args?.[1] === 'tap');

  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.alive = true;
    mockSupportsApi.mockResolvedValue(true);
    mockSupportsNested.mockResolvedValue(true);
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  it('hit-tests the tap point with describe-point before tapping', async () => {
    mockDevice({
      type: 'Button',
      AXLabel: 'Unlock',
      AXUniqueId: 'log-in-button',
      frame: loginButton.frame,
    });
    // A caller-resolved element on a fresh backend resolves its (unknown)
    // ancestors against one snapshot; clear it from the call log so this test
    // stays about the hit-test order.
    await backend.snapshot();
    mockExecStrict.mockClear();

    await backend.tapElement(
      { identifier: 'log-in-button' },
      { element: loginButton },
    );

    const calls = mockExecStrict.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[0] === 'ui');
    expect(calls).toStrictEqual([
      [
        'ui',
        'describe-point',
        '201',
        '556',
        '--api',
        'axbridge',
        '--json',
        '--udid',
        udid,
      ],
      ['ui', 'tap', '201', '556', '--udid', udid],
    ]);
  });

  it('accepts a child of the target at the point (a label inside the button)', async () => {
    mockDevice({
      type: 'StaticText',
      AXLabel: 'Unlock',
      frame: { x: 170, y: 545, width: 60, height: 22 },
    });

    await backend.tapElement(
      { identifier: 'log-in-button' },
      { element: loginButton },
    );

    expect(tapCalls()).toHaveLength(1);
  });

  it('refuses the tap when the keyboard covers the target (B2)', async () => {
    // Keyboard up on the login screen: the AutoFill bar sits over Unlock.
    mockDevice({
      type: 'Button',
      AXLabel: 'Passwords',
      AXUniqueId: null,
      frame: { x: 30, y: 546, width: 342, height: 44 },
    });

    const error = await backend
      .tapElement({ identifier: 'log-in-button' }, { element: loginButton })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TargetObscuredError);
    expect(error).toMatchObject({
      code: 'TARGET_OBSCURED',
      keyboard: true,
      x: 201,
      y: 556,
      obscuredBy: { type: 'Button', label: 'Passwords' },
    });
    expect((error as Error).message).toContain('by the keyboard');
    expect(tapCalls()).toHaveLength(0);
  });

  it('refuses the tap when an overlay covers the target', async () => {
    mockDevice({
      type: 'Other',
      AXLabel: 'Bottom sheet',
      AXUniqueId: 'sheet',
      frame: { x: 0, y: 400, width: 402, height: 474 },
    });

    await expect(
      backend.tapElement(
        { identifier: 'log-in-button' },
        { element: loginButton },
      ),
    ).rejects.toMatchObject({
      code: 'TARGET_OBSCURED',
      keyboard: false,
      message: expect.stringContaining('Close the overlay'),
    });
    expect(tapCalls()).toHaveLength(0);
  });

  it('taps when the hit-test finds no element at the point', async () => {
    mockDevice(
      new Error('The axbridge backend found no element at (201.0, 556.0)'),
    );

    await backend.tapElement(
      { identifier: 'log-in-button' },
      { element: loginButton },
    );

    expect(tapCalls()).toHaveLength(1);
  });

  it('taps when the hit-test output is not JSON', async () => {
    mockDevice('not json');

    await backend.tapElement(
      { identifier: 'log-in-button' },
      { element: loginButton },
    );

    expect(tapCalls()).toHaveLength(1);
  });

  it('skips the hit-test when idb cannot select the accessibility API', async () => {
    mockSupportsApi.mockResolvedValue(false);
    mockDevice(new Error('must not be called'));

    await backend.tapElement(
      { identifier: 'log-in-button' },
      { element: loginButton },
    );

    expect(
      mockExecStrict.mock.calls.filter(
        ([, args]) => args?.[1] === 'describe-point',
      ),
    ).toHaveLength(0);
    expect(tapCalls()).toHaveLength(1);
  });

  it('hit-tests long presses too', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.[0] === 'describe' && args.includes('--json')) {
        return JSON.stringify({
          os_version: '26.5',
          screen_dimensions: { width_points: 402, height_points: 874 },
        });
      }
      if (args?.[1] === 'describe-all') {
        return JSON.stringify([
          {
            type: 'Button',
            AXLabel: 'Unlock',
            AXUniqueId: 'log-in-button',
            frame: loginButton.frame,
          },
        ]);
      }
      if (args?.[1] === 'describe-point') {
        return JSON.stringify({
          type: 'Key',
          AXLabel: 'space',
          frame: { x: 100, y: 540, width: 200, height: 40 },
        });
      }
      return '';
    });

    await expect(
      backend.longPress({ identifier: 'log-in-button' }),
    ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
    expect(tapCalls()).toHaveLength(0);
  });

  describe('when the query matched a label inside a button', () => {
    const label: Record<string, unknown> = {
      type: 'StaticText',
      AXLabel: 'Unlock',
      frame: { x: 170, y: 545, width: 60, height: 22 },
      enabled: true,
    };

    it('accepts the tap when describe-point returns the button around the label', async () => {
      // Nested snapshot: the static text is a child of the button.
      mockDevice(
        {
          type: 'Button',
          AXLabel: 'Unlock',
          AXUniqueId: 'log-in-button',
          frame: loginButton.frame,
        },
        [
          {
            type: 'Button',
            AXUniqueId: 'log-in-button',
            frame: loginButton.frame,
            enabled: true,
            children: [label],
          },
        ],
      );

      await backend.tapElement({ text: 'Unlock' });

      expect(tapCalls()).toHaveLength(1);
    });

    it('accepts a flat snapshot whose button repeats the matched label', async () => {
      // Flat snapshot: no children, so only the label relation links them.
      mockDevice(
        {
          type: 'Button',
          AXLabel: 'Unlock',
          frame: loginButton.frame,
        },
        [label],
      );

      await backend.tapElement({ text: 'Unlock' });

      expect(tapCalls()).toHaveLength(1);
    });

    it('still refuses an overlay that contains the matched label', async () => {
      mockDevice(
        {
          type: 'Other',
          AXLabel: 'Bottom sheet',
          AXUniqueId: 'sheet',
          frame: { x: 0, y: 400, width: 402, height: 474 },
        },
        [label],
      );

      await expect(
        backend.tapElement({ text: 'Unlock' }),
      ).rejects.toMatchObject({
        code: 'TARGET_OBSCURED',
        keyboard: false,
      });
      expect(tapCalls()).toHaveLength(0);
    });

    it('still refuses the keyboard that contains the matched label', async () => {
      mockDevice(
        {
          type: 'Button',
          AXLabel: 'Passwords',
          frame: { x: 30, y: 546, width: 342, height: 44 },
        },
        [label],
      );

      await expect(
        backend.tapElement({ text: 'Unlock' }),
      ).rejects.toMatchObject({
        code: 'TARGET_OBSCURED',
        keyboard: true,
      });
      expect(tapCalls()).toHaveLength(0);
    });
  });

  describe('for an element returned by waitForElement', () => {
    const confirmLabel: Record<string, unknown> = {
      type: 'StaticText',
      AXLabel: 'Confirm',
      frame: { x: 170, y: 545, width: 60, height: 22 },
      enabled: true,
    };
    const container: Record<string, unknown> = {
      type: 'Button',
      AXLabel: 'Primary action',
      AXUniqueId: 'primary-btn',
      frame: loginButton.frame,
      enabled: true,
      children: [confirmLabel],
    };
    const containerHit = {
      type: 'Button',
      AXLabel: 'Primary action',
      AXUniqueId: 'primary-btn',
      frame: loginButton.frame,
    };

    const describeAllCalls = (): number =>
      mockExecStrict.mock.calls.filter(
        ([, args]) => args?.[1] === 'describe-all',
      ).length;

    it('finds its ancestors in the last snapshot although the labels differ', async () => {
      mockDevice(containerHit, [container]);

      const element = await backend.waitForElement({ label: 'Confirm' });
      await backend.tapElement({ label: 'Confirm' }, { element });

      // The element came from the snapshot waitForElement took: no new one.
      expect(describeAllCalls()).toBe(1);
      expect(tapCalls()).toHaveLength(1);
    });

    it('has no ancestors when the element is not from the last snapshot', async () => {
      mockDevice(containerHit, [container]);

      const element = await backend.waitForElement({ label: 'Confirm' });
      // A copy is not the object in the hierarchy: identity fails.
      await expect(
        backend.tapElement({ label: 'Confirm' }, { element: { ...element } }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(tapCalls()).toHaveLength(0);
    });

    it('refuses a larger hit when the element is from an earlier snapshot', async () => {
      // The target comes from the snapshot `waitForElement` took; a later
      // `snapshot()` replaces the stored hierarchy. The target is then not in
      // it, so its ancestors are unknown. The hierarchy is nested, so the
      // flat label rule must not accept the aggregated sheet on top of it.
      mockDevice(
        {
          type: 'Other',
          AXLabel: 'Review transaction, 0.5 ETH, Cancel, Confirm',
          frame: { x: 0, y: 400, width: 390, height: 444 },
        },
        [
          {
            type: 'Application',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            enabled: true,
            children: [
              {
                type: 'Button',
                AXLabel: 'Primary action',
                AXUniqueId: 'confirm-btn',
                frame: { x: 100, y: 600, width: 190, height: 48 },
                enabled: true,
                children: [
                  {
                    type: 'StaticText',
                    AXLabel: 'Confirm',
                    frame: { x: 120, y: 610, width: 150, height: 24 },
                    enabled: true,
                  },
                ],
              },
            ],
          },
        ],
        { widthPoints: 390, heightPoints: 844 },
      );

      const element = await backend.waitForElement({ label: 'Confirm' });
      await backend.snapshot();
      await expect(
        backend.tapElement({ label: 'Confirm' }, { element }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(tapCalls()).toHaveLength(0);
    });

    it('snapshots once to resolve a caller element when none is stored', async () => {
      // A fresh backend has no stored hierarchy. Resolving the caller's
      // element against a nested snapshot refuses the larger button instead
      // of falling back to the flat label rule.
      const callerElement: UIElement = {
        type: 'StaticText',
        label: 'Confirm',
        frame: { x: 100, y: 700, width: 60, height: 22 },
        enabled: true,
      };
      mockDevice(
        {
          type: 'Button',
          AXLabel: 'Close, Confirm',
          frame: { x: 0, y: 600, width: 390, height: 244 },
        },
        [
          {
            type: 'Application',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            enabled: true,
            children: [
              {
                type: 'Other',
                frame: { x: 0, y: 600, width: 390, height: 244 },
                enabled: true,
                children: [
                  {
                    type: 'Button',
                    AXLabel: 'Primary action',
                    frame: { x: 20, y: 610, width: 350, height: 48 },
                    enabled: true,
                  },
                ],
              },
            ],
          },
        ],
        { widthPoints: 390, heightPoints: 844 },
      );

      await expect(
        backend.tapElement({ label: 'Confirm' }, { element: callerElement }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(describeAllCalls()).toBe(1);
      expect(tapCalls()).toHaveLength(0);
    });

    it('refuses a full-screen backdrop that matches the root ancestor', async () => {
      const backdrop = {
        type: 'Other',
        frame: { x: 0, y: 0, width: 402, height: 874 },
        enabled: true,
      };
      mockDevice(backdrop, [
        {
          ...backdrop,
          children: [
            {
              type: 'Button',
              AXLabel: 'Primary action',
              frame: { x: 20, y: 400, width: 360, height: 48 },
              enabled: true,
              children: [
                {
                  type: 'StaticText',
                  AXLabel: 'Confirm',
                  frame: { x: 100, y: 414, width: 60, height: 22 },
                  enabled: true,
                },
              ],
            },
          ],
        },
      ]);

      const element = await backend.waitForElement({ label: 'Confirm' });
      await expect(
        backend.tapElement({ label: 'Confirm' }, { element }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED', keyboard: false });
      expect(tapCalls()).toHaveLength(0);
    });
  });

  describe('overlay and ancestor safety', () => {
    it('refuses a same-frame unlabelled veil around a nested target', async () => {
      // Regression: an absoluteFill loading veil with the same type and frame
      // as a real wrapper must not pass as the target's container.
      const veil = {
        type: 'Other',
        frame: { x: 0, y: 100, width: 390, height: 661 },
        enabled: true,
        children: [
          {
            type: 'Button',
            AXLabel: 'Confirm',
            frame: { x: 100, y: 300, width: 190, height: 48 },
            enabled: true,
          },
        ],
      };
      mockDevice(
        veil,
        [
          {
            type: 'Application',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            enabled: true,
            children: [veil],
          },
        ],
        { widthPoints: 390, heightPoints: 844 },
      );

      const element = await backend.waitForElement({ label: 'Confirm' });
      await expect(
        backend.tapElement({ label: 'Confirm' }, { element }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(tapCalls()).toHaveLength(0);
    });

    it('refuses a Fabric-aggregated sheet label with a nested chain', async () => {
      const target = {
        type: 'StaticText',
        AXLabel: 'Confirm',
        frame: { x: 120, y: 610, width: 150, height: 24 },
        enabled: true,
      };
      mockDevice(
        {
          type: 'Other',
          AXLabel: 'Review transaction, 0.5 ETH, Cancel, Confirm',
          frame: { x: 0, y: 400, width: 390, height: 444 },
        },
        [
          {
            type: 'Application',
            frame: { x: 0, y: 0, width: 390, height: 844 },
            enabled: true,
            children: [
              {
                type: 'Button',
                AXLabel: 'Confirm',
                AXUniqueId: 'confirm-btn',
                frame: { x: 100, y: 600, width: 190, height: 48 },
                enabled: true,
                children: [target],
              },
            ],
          },
        ],
        { widthPoints: 390, heightPoints: 844 },
      );

      const element = await backend.waitForElement({ label: 'Confirm' });
      await expect(
        backend.tapElement({ label: 'Confirm' }, { element }),
      ).rejects.toMatchObject({ code: 'TARGET_OBSCURED' });
      expect(tapCalls()).toHaveLength(0);
    });

    it('keeps ancestors when getWindowSize takes a snapshot', async () => {
      // Regression: a describe without point dimensions makes getWindowSize
      // snapshot, which must not replace the hierarchy the element came from.
      const elementNode = {
        type: 'StaticText',
        AXLabel: 'Confirm',
        frame: { x: 100, y: 414, width: 60, height: 22 },
        enabled: true,
      };
      mockExecStrict.mockImplementation(async (_cmd, args) => {
        if (args?.[0] === 'describe' && args.includes('--json')) {
          return JSON.stringify({ os_version: '26.5' });
        }
        if (args?.[1] === 'describe-all') {
          return JSON.stringify([
            {
              type: 'Application',
              frame: { x: 0, y: 0, width: 402, height: 874 },
              enabled: true,
              children: [
                {
                  type: 'Button',
                  AXLabel: 'Primary action',
                  AXUniqueId: 'primary-btn',
                  frame: { x: 20, y: 400, width: 360, height: 48 },
                  enabled: true,
                  children: [elementNode],
                },
              ],
            },
          ]);
        }
        if (args?.[1] === 'describe-point') {
          return JSON.stringify({
            type: 'Button',
            AXLabel: 'Primary action',
            AXUniqueId: 'primary-btn',
            frame: { x: 20, y: 400, width: 360, height: 48 },
          });
        }
        return '';
      });

      const element = await backend.waitForElement({ label: 'Confirm' });
      await backend.tapElement({ label: 'Confirm' }, { element });

      const describeAllCalls = mockExecStrict.mock.calls.filter(
        ([, args]) => args?.[1] === 'describe-all',
      );
      expect(tapCalls()).toHaveLength(1);
      // One for waitForElement, one for the getWindowSize fallback.
      expect(describeAllCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('iOS Settings fixtures', () => {
    const fixture = (name: string): Record<string, unknown>[] =>
      JSON.parse(
        readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
      ) as Record<string, unknown>[];
    const nested = fixture('idb-describe-all-settings-nested.json');
    const flat = fixture('idb-describe-all-settings-flat.json');
    const screen = { widthPoints: 390, heightPoints: 844 };

    const generalHit = {
      type: 'Button',
      AXLabel: 'General',
      AXUniqueId: 'com.apple.settings.general',
      frame: { x: 16, y: 80, width: 370, height: 44 },
    };
    const accountHit = {
      type: 'Button',
      AXLabel:
        'Apple Account, Sign in to access your iCloud data, the App Store, Apple services, and more.',
      AXUniqueId: 'com.apple.settings.primaryAppleAccount',
      frame: { x: 16, y: 168, width: 370, height: 90 },
    };

    it.each([
      ['General', { type: 'StaticText', label: 'General' }, generalHit],
      [
        'Apple Account',
        { type: 'StaticText', label: 'Apple Account' },
        accountHit,
      ],
      [
        'Sign in to access',
        { type: 'StaticText', label: 'Sign in to access' },
        accountHit,
      ],
    ])(
      'taps the "%s" row through its button (nested)',
      async (_, query, hit) => {
        mockDevice(hit, nested, screen);

        await backend.tapElement(query);

        expect(tapCalls()).toHaveLength(1);
      },
    );

    it.each([
      ['General', { type: 'StaticText', label: 'General' }, generalHit],
      [
        'Apple Account',
        { type: 'StaticText', label: 'Apple Account' },
        accountHit,
      ],
      [
        'Sign in to access',
        { type: 'StaticText', label: 'Sign in to access' },
        accountHit,
      ],
    ])('taps the "%s" row through its button (flat)', async (_, query, hit) => {
      mockDevice(hit, flat, screen);

      await backend.tapElement(query);

      expect(tapCalls()).toHaveLength(1);
    });
  });
});

describe('IdbBackend device description cache', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  let backend: IdbBackend;

  const screenInfo = {
    name: 'iPhone 17 Pro',
    os_version: '26.5',
    state: 'Booted',
    screen_dimensions: { width_points: 402, height_points: 874 },
  };
  const button = {
    type: 'Button',
    AXLabel: 'Submit',
    AXUniqueId: 'submit-btn',
    frame: { x: 10, y: 20, width: 100, height: 44 },
    enabled: true,
  };

  const describeJsonCalls = (): number =>
    mockExecStrict.mock.calls.filter(
      ([, args]) => args?.includes('describe') && args?.includes('--json'),
    ).length;
  const describeAllCalls = (api: 'ax' | 'axbridge'): number =>
    mockExecStrict.mock.calls.filter(
      ([, args]) =>
        args?.includes('describe-all') &&
        args[args.indexOf('--api') + 1] === api,
    ).length;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify(screenInfo);
      }
      if (args?.includes('describe-all')) {
        return JSON.stringify([button]);
      }
      return '';
    });
    backend = new IdbBackend(udid);
  });

  afterEach(() => {
    mockSupportsApi.mockResolvedValue(false);
    mockChooseAxApi.mockReturnValue(null);
  });

  it('reads idb describe once per connection for snapshots and taps', async () => {
    const element = await backend.waitForElement({ identifier: 'submit-btn' });
    await backend.tapElement({ identifier: 'submit-btn' }, { element });
    await backend.snapshot();
    await backend.tapElement({ identifier: 'submit-btn' });
    await backend.swipe('up');

    expect(describeJsonCalls()).toBe(1);
    // waitForElement, snapshot, and the second (unresolved) tap; each
    // axbridge snapshot also reads `ax` for the elements axbridge drops.
    expect(describeAllCalls('axbridge')).toBe(3);
    expect(describeAllCalls('ax')).toBe(3);
  });

  it('shares one describe read between concurrent first calls', async () => {
    await Promise.all([backend.snapshot(), backend.getWindowSize()]);

    expect(describeJsonCalls()).toBe(1);
  });

  it('reads the description again after a reconnect', async () => {
    await backend.snapshot();
    await backend.reconnect();
    await backend.snapshot();

    expect(describeJsonCalls()).toBe(2);
  });

  it('does not cache a failed read', async () => {
    let failures = 1;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        if (failures > 0) {
          failures -= 1;
          throw new Error('companion busy');
        }
        return JSON.stringify(screenInfo);
      }
      return JSON.stringify([button]);
    });

    await expect(backend.getWindowSize()).rejects.toThrow('companion busy');
    expect(await backend.getWindowSize()).toStrictEqual({
      width: 402,
      height: 874,
    });
    expect(describeJsonCalls()).toBe(2);
  });

  it('getDeviceInfo reads fresh and refreshes the cache', async () => {
    await backend.getWindowSize();
    const info = await backend.getDeviceInfo();
    await backend.getWindowSize();

    expect(info).toStrictEqual({
      platform: 'ios',
      deviceId: udid,
      name: 'iPhone 17 Pro',
      osVersion: '26.5',
      state: 'Booted',
    });
    expect(describeJsonCalls()).toBe(2);
  });

  it('keeps the cached description when a getDeviceInfo read fails', async () => {
    await backend.getWindowSize();
    mockExecStrict.mockImplementationOnce(async () => {
      throw new Error('companion busy');
    });

    await expect(backend.getDeviceInfo()).rejects.toThrow('companion busy');
    expect(await backend.getWindowSize()).toStrictEqual({
      width: 402,
      height: 874,
    });
    expect(describeJsonCalls()).toBe(2);
  });

  it('serves the cached description while getDeviceInfo reads', async () => {
    await backend.getWindowSize();
    let finishRead: (raw: string) => void = () => undefined;
    mockExecStrict.mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const refreshing = backend.getDeviceInfo();

    expect(await backend.getWindowSize()).toStrictEqual({
      width: 402,
      height: 874,
    });

    finishRead(
      JSON.stringify({
        ...screenInfo,
        screen_dimensions: { width_points: 874, height_points: 402 },
      }),
    );
    await refreshing;
    expect(await backend.getWindowSize()).toStrictEqual({
      width: 874,
      height: 402,
    });
    expect(describeJsonCalls()).toBe(2);
  });

  it('does not cache a getDeviceInfo read that a reconnect overtook', async () => {
    let finishRead: (raw: string) => void = () => undefined;
    await backend.ensureConnected();
    mockExecStrict.mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    );
    const refreshing = backend.getDeviceInfo();
    await backend.reconnect();
    finishRead(JSON.stringify(screenInfo));
    await refreshing;

    await backend.getWindowSize();
    expect(describeJsonCalls()).toBe(2);
  });

  it('falls back to the snapshot root when describe is not JSON', async () => {
    // Without --api support the snapshot does not need the OS version.
    mockSupportsApi.mockResolvedValue(false);
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return 'not json';
      }
      return JSON.stringify([
        { type: 'Application', frame: { x: 0, y: 0, width: 390, height: 844 } },
      ]);
    });

    expect(await backend.getWindowSize()).toStrictEqual({
      width: 390,
      height: 844,
    });
  });

  it('getDeviceInfo rejects a non-JSON description', async () => {
    mockExecStrict.mockResolvedValue('not json');

    await expect(backend.getDeviceInfo()).rejects.toThrow(
      `idb describe returned invalid JSON for device ${udid}: not json`,
    );
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

    expect(connectionMocks.connect).toHaveBeenCalledWith('/usr/local/bin/idb');
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
    expect(connectionMocks.connect).toHaveBeenCalledWith('/usr/local/bin/idb');
  });

  it('shares in-flight initialization and waits for it before disposal', async () => {
    let ready!: () => void;
    connectionMocks.connect.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const first = backend.ensureConnected();
    const second = backend.ensureConnected();
    // Let path/capability probes finish before ending the session.
    await vi.waitFor(() =>
      expect(connectionMocks.connect).toHaveBeenCalledTimes(1),
    );
    const firstRejected = first.catch((error: unknown) => error);
    const secondRejected = second.catch((error: unknown) => error);
    const disposing = backend.dispose();
    expect(connectionMocks.dispose).not.toHaveBeenCalled();
    ready();
    await Promise.all([disposing, backend.dispose()]);
    expect(await firstRejected).toMatchObject({
      message: 'IDB backend has been disposed',
    });
    expect(await secondRejected).toMatchObject({
      message: 'IDB backend has been disposed',
    });
    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
    await expect(backend.snapshot()).rejects.toThrow('disposed');
  });

  it('releases a partially started connection after initialization fails', async () => {
    connectionMocks.connect.mockRejectedValueOnce(new Error('startup failed'));
    await expect(backend.ensureConnected()).rejects.toThrow('startup failed');
    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
    await backend.ensureConnected();
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it('waits for an owned recording to exit before disposing its companion', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null,
      signalCode: null,
      kill: vi.fn().mockReturnValue(true),
    });
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );
    await backend.startScreenRecording('/tmp/session-recording.mp4');
    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      ['record-video', '/tmp/session-recording.mp4', '--udid', udid],
      connectionOptions,
    );
    const disposing = backend.dispose();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGINT'));
    expect(connectionMocks.dispose).not.toHaveBeenCalled();
    child.emit('exit', 0);
    await disposing;
    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('retries failed disposal without allowing new device commands', async () => {
    await backend.ensureConnected();
    connectionMocks.dispose.mockRejectedValueOnce(new Error('stop failed'));
    await expect(backend.dispose()).rejects.toThrow(
      'IDB backend disposal failed',
    );
    await expect(backend.snapshot()).rejects.toThrow('disposed');
    await backend.dispose();
    expect(connectionMocks.dispose).toHaveBeenCalledTimes(2);
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
    mockSupportsNested.mockResolvedValue(false);
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
      connectionOptions,
    );
    expect(mockExecStrict).not.toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      expect.arrayContaining(['--api']),
      connectionOptions,
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
      connectionOptions,
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
      connectionOptions,
    );
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'ax']),
      connectionOptions,
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

  it.each([false, true])(
    'uses --nested only when supported (%s), probing once per backend',
    async (supported) => {
      mockSupportsApi.mockResolvedValue(false);
      mockSupportsNested.mockResolvedValue(supported);
      mockExecStrict.mockResolvedValue(JSON.stringify([]));

      await backend.snapshot();
      await backend.snapshot();

      expect(mockExecStrict).toHaveBeenCalledTimes(2);
      expect(mockExecStrict).toHaveBeenNthCalledWith(
        1,
        '/usr/local/bin/idb',
        describeArgs(supported ? ['--nested'] : []),
        connectionOptions,
      );
      expect(mockExecStrict).toHaveBeenNthCalledWith(
        2,
        '/usr/local/bin/idb',
        describeArgs(supported ? ['--nested'] : []),
        connectionOptions,
      );
      expect(mockSupportsNested).toHaveBeenCalledExactlyOnceWith(
        '/usr/local/bin/idb',
      );
    },
  );

  it('passes --nested with every --api attempt', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockSupportsNested.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('describe') && args?.includes('--json')) {
        return JSON.stringify({ os_version: '26.1', name: 'iPhone' });
      }
      if (args?.includes('axbridge')) {
        throw new Error('axbridge backend requested accessibility failed');
      }
      return JSON.stringify([]);
    });

    await backend.snapshot();

    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'axbridge', '--nested']),
      connectionOptions,
    );
    expect(mockExecStrict).toHaveBeenCalledWith(
      '/usr/local/bin/idb',
      describeArgs(['--api', 'ax', '--nested']),
      connectionOptions,
    );
  });

  it('returns the nested tree from snapshot', async () => {
    mockSupportsApi.mockResolvedValue(false);
    mockSupportsNested.mockResolvedValue(true);
    mockExecStrict.mockResolvedValue(
      JSON.stringify([
        {
          type: 'Application',
          frame: { x: 0, y: 0, width: 402, height: 874 },
          children: [
            {
              type: 'Button',
              AXLabel: 'Unlock',
              AXUniqueId: 'log-in-button',
              frame: { x: 24, y: 396, width: 354, height: 48 },
              children: [],
            },
          ],
        },
      ]),
    );

    const { hierarchy } = await backend.snapshot();

    expect(hierarchy).toHaveLength(1);
    expect(hierarchy[0].children?.[0].identifier).toBe('log-in-button');
    expect(hierarchy[0].children?.[0].children).toBeUndefined();
  });

  describe('ax supplement for axbridge', () => {
    const node = (
      id: string | null,
      frame: { x: number; y: number; width: number; height: number },
      children: unknown[] = [],
      label: string | null = null,
    ): Record<string, unknown> => ({
      type: id ? 'Button' : 'RCTViewComponentView',
      AXUniqueId: id,
      AXLabel: label,
      frame,
      children,
    });
    const axbridgeTree = [
      node(null, { x: 0, y: 0, width: 402, height: 874 }, [
        node('wallet-screen', { x: 0, y: 0, width: 402, height: 874 }, [
          // The unlabelled container that hides the action row.
          node(null, { x: 0, y: 134, width: 402, height: 439 }),
          node('account-picker', { x: 60, y: 78, width: 163, height: 24 }),
        ]),
      ]),
    ];
    const axTree = [
      node(null, { x: 0, y: 0, width: 402, height: 874 }, [
        node('account-picker', { x: 60, y: 78, width: 163, height: 24 }),
        node(
          'wallet-send-button',
          { x: 205, y: 242, width: 87, height: 73 },
          [],
          'Send',
        ),
        node('offscreen-card', { x: 966, y: 1075, width: 180, height: 180 }),
        node(null, { x: 1, y: 1, width: 1, height: 1 }, [], 'no id'),
      ]),
    ];

    const mockApis = (ax: () => Promise<string>): void => {
      mockSupportsApi.mockResolvedValue(true);
      mockSupportsNested.mockResolvedValue(true);
      mockChooseAxApi.mockReturnValue('axbridge');
      mockExecStrict.mockImplementation(async (_cmd, args) => {
        if (args?.includes('describe') && args?.includes('--json')) {
          return JSON.stringify({ os_version: '27.0', name: 'iPhone' });
        }
        if (args?.includes('axbridge')) {
          return JSON.stringify(axbridgeTree);
        }
        return ax();
      });
    };

    it('adds identified elements that only ax reports, inside the smallest containing element', async () => {
      mockApis(async () => JSON.stringify(axTree));

      const { hierarchy, raw } = await backend.snapshot();

      expect(raw).toBe(JSON.stringify(axbridgeTree));
      const send = findElement(hierarchy, { identifier: 'wallet-send-button' });
      expect(send).toMatchObject({
        label: 'Send',
        frame: { x: 205, y: 242, width: 87, height: 73 },
      });
      const container = hierarchy[0].children?.[0].children?.[0];
      expect(container?.children?.map((el) => el.identifier)).toStrictEqual([
        'wallet-send-button',
      ]);
      // Not contained by any axbridge frame: added at the top level.
      expect(hierarchy.at(-1)?.identifier).toBe('offscreen-card');
      // account-picker is not duplicated; unidentified ax nodes are skipped.
      const ids: (string | undefined)[] = [];
      const walk = (els: typeof hierarchy): void =>
        els.forEach((el) => {
          ids.push(el.identifier ?? el.label);
          walk(el.children ?? []);
        });
      walk(hierarchy);
      expect(ids.filter((id) => id === 'account-picker')).toHaveLength(1);
      expect(ids).not.toContain('no id');
    });

    it('returns the axbridge tree unchanged when the ax read fails', async () => {
      mockApis(async () => {
        throw new Error('ax failed');
      });

      const { hierarchy } = await backend.snapshot();

      expect(hierarchy).toStrictEqual(
        parseIdbHierarchy(JSON.stringify(axbridgeTree)),
      );
    });

    it('does not read a supplement when ax is the preferred backend', async () => {
      mockSupportsApi.mockResolvedValue(true);
      mockChooseAxApi.mockReturnValue('ax');
      mockExecStrict.mockImplementation(async (_cmd, args) => {
        if (args?.includes('describe') && args?.includes('--json')) {
          return JSON.stringify({ os_version: '17.4', name: 'iPhone' });
        }
        return JSON.stringify(axTree);
      });

      await backend.snapshot();

      const describeCalls = mockExecStrict.mock.calls.filter(
        ([, args]) => args?.[1] === 'describe-all',
      );
      expect(describeCalls).toHaveLength(1);
    });
  });

  it('rethrows a non-Error rejection as a descriptive Error', async () => {
    mockSupportsApi.mockResolvedValue(false);
    mockExecStrict.mockRejectedValue('boom');

    await expect(backend.snapshot()).rejects.toThrow(
      'idb ui describe-all failed for all accessibility backends',
    );
  });
});

describe('IdbBackend keys and buttons', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  const idb = '/usr/local/bin/idb';
  let backend: IdbBackend;

  const idbCalls = (): unknown[][] =>
    mockExecStrict.mock.calls
      .filter(([cmd, args]) => cmd === idb && args?.[0] === 'ui')
      .filter(([, args]) => args?.[1] !== 'describe-all')
      .map(([, args]) => args as unknown[]);

  const hierarchyWith = (types: string[]): string =>
    JSON.stringify([
      {
        type: 'Application',
        AXLabel: 'MetaMask',
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: types.map((type) => ({
          type,
          frame: { x: 0, y: 590, width: 402, height: 284 },
        })),
      },
    ]);

  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.alive = true;
    mockSupportsApi.mockResolvedValue(false);
    mockSupportsNested.mockResolvedValue(true);
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    mockExecStrict.mockResolvedValue('');
    backend = new IdbBackend(udid);
  });

  it.each([
    ['enter', ['ui', 'key', '40', '--udid', udid]],
    ['home', ['ui', 'button', 'HOME', '--udid', udid]],
    ['lock', ['ui', 'button', 'LOCK', '--udid', udid]],
  ] as const)('pressButton(%s) sends %j', async (button, args) => {
    await backend.pressButton(button);

    expect(mockExecStrict).toHaveBeenCalledWith(idb, args, connectionOptions);
    expect(idbCalls()).toStrictEqual([args]);
  });

  it('rejects pressButton(back) without touching the device', async () => {
    await expect(backend.pressButton('back')).rejects.toMatchObject({
      code: 'UNSUPPORTED_ON_IOS',
      message: expect.stringContaining('iOS has no back button'),
    });
    expect(mockExecStrict).not.toHaveBeenCalled();
    expect(connectionMocks.connect).not.toHaveBeenCalled();
  });

  it('clears with Command+A and Backspace before typing, all strict', async () => {
    await backend.typeText('hello world');

    expect(idbCalls()).toStrictEqual([
      ['ui', 'key', '4', '--command', '--udid', udid],
      ['ui', 'key', '42', '--udid', udid],
      ['ui', 'text', 'hello world', '--udid', udid],
    ]);
    expect(mockExec).not.toHaveBeenCalledWith(
      idb,
      expect.anything(),
      expect.anything(),
    );
  });

  it('presses Return to dismiss a visible keyboard', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) =>
      args?.[1] === 'describe-all' ? hierarchyWith(['Keyboard']) : '',
    );

    await backend.dismissKeyboard();

    expect(idbCalls()).toStrictEqual([['ui', 'key', '40', '--udid', udid]]);
  });

  it('does nothing when no keyboard is shown', async () => {
    // React Native's full-screen KeyboardControllerView is always present
    // and must not count as a keyboard.
    mockExecStrict.mockImplementation(async (_cmd, args) =>
      args?.[1] === 'describe-all'
        ? hierarchyWith(['KeyboardControllerView'])
        : '',
    );

    await backend.dismissKeyboard();

    expect(idbCalls()).toStrictEqual([]);
  });
});

describe('IdbBackend companion recovery', () => {
  const udid = 'AAAA1111-BBBB-CCCC-DDDD-EEEE2222FFFF';
  const hidInvalidated =
    'Command failed: idb ui tap 10 20\nExit code: 1\nstderr: The dtuhidd connection ' +
    '(com.apple.coredevice.feature.remote.hid.digitizer) has been invalidated; ' +
    'events sent on it would be discarded';
  const companionGone =
    "Command failed: idb ui describe-all\nExit code: 1\nstderr: Failed to connect to companion at address DomainSocketAddress(path='/tmp/device-mcp-idb-x/companion.sock'): [Errno 61] Connection refused";
  let backend: IdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.alive = true;
    mockSupportsApi.mockResolvedValue(false);
    mockSupportsNested.mockResolvedValue(false);
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    backend = new IdbBackend(udid);
  });

  const tapCalls = (): unknown[][] =>
    mockExecStrict.mock.calls.filter(([, args]) => args?.[1] === 'tap');

  it('starts a fresh companion on the next call when the companion died after readiness', async () => {
    mockExecStrict.mockResolvedValue('');
    await backend.tapCoordinates(1, 2);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(1);

    connectionState.alive = false;
    connectionMocks.connect.mockImplementationOnce(async () => {
      connectionState.alive = true;
    });
    await backend.tapCoordinates(3, 4);

    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
    expect(tapCalls()).toHaveLength(2);
    expect(tapCalls()[1][1]).toStrictEqual([
      'ui',
      'tap',
      '3',
      '4',
      '--udid',
      udid,
    ]);
    // Capability probes are not repeated on reconnect.
    expect(platformModule.resolveIdbPath).toHaveBeenCalledTimes(1);
  });

  it('reconnects once and retries once when the HID connection is invalidated', async () => {
    mockExecStrict
      .mockRejectedValueOnce(new Error(hidInvalidated))
      .mockResolvedValueOnce('');

    await backend.tapCoordinates(10, 20);

    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
    expect(tapCalls()).toHaveLength(2);
  });

  it('throws IDB_HID_UNAVAILABLE after one failed retry, without looping', async () => {
    mockExecStrict.mockRejectedValue(new Error(hidInvalidated));

    const error = await backend.tapCoordinates(10, 20).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IdbUnavailableError);
    expect(error).toMatchObject({ code: 'IDB_HID_UNAVAILABLE', udid });
    expect((error as Error).message).toContain('xcrun simctl shutdown');
    expect(tapCalls()).toHaveLength(2);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it('throws IDB_COMPANION_UNAVAILABLE when the companion cannot be reached after a restart', async () => {
    mockExecStrict.mockRejectedValue(new Error(companionGone));

    await expect(backend.snapshot()).rejects.toMatchObject({
      code: 'IDB_COMPANION_UNAVAILABLE',
    });
    const describeCalls = mockExecStrict.mock.calls.filter(
      ([, args]) => args?.[1] === 'describe-all',
    );
    expect(describeCalls).toHaveLength(2);
  });

  it('does not try another accessibility API after a typed transport failure', async () => {
    mockSupportsApi.mockResolvedValue(true);
    mockChooseAxApi.mockReturnValue('axbridge');
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('--json')) {
        return JSON.stringify({ os_version: '26.1' });
      }
      throw new Error(companionGone);
    });

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      IdbUnavailableError,
    );
    const apis = mockExecStrict.mock.calls
      .filter(([, args]) => args?.[1] === 'describe-all')
      .map(([, args]) => args?.[args.indexOf('--api') + 1]);
    // axbridge is read and retried once; the one ax read is the concurrent
    // best-effort supplement, not a fallback.
    expect(apis.filter((api) => api === 'axbridge')).toHaveLength(2);
    expect(apis.filter((api) => api === 'ax')).toHaveLength(1);
  });

  it('does not resend a mutating command when delivery is uncertain', async () => {
    mockExecStrict.mockRejectedValue(
      new Error('stderr: StatusCode.UNAVAILABLE: Socket closed'),
    );

    await expect(backend.tapCoordinates(1, 1)).rejects.toMatchObject({
      code: 'IDB_COMPANION_UNAVAILABLE',
      message: expect.stringContaining('may have run'),
    });
    expect(tapCalls()).toHaveLength(1);
    // The companion was still replaced for the next command.
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['launch', async (): Promise<void> => backend.openApp('io.metamask')],
    ['terminate', async (): Promise<void> => backend.closeApp('io.metamask')],
  ])(
    'does not resend idb %s when delivery is uncertain',
    async (command, run) => {
      mockExecStrict.mockImplementation(async (cmd) => {
        if (cmd === 'xcrun') {
          return '';
        }
        throw new Error('stderr: StatusCode.UNAVAILABLE: Socket closed');
      });

      await run();

      const idbCalls = mockExecStrict.mock.calls.filter(
        ([cmd, args]) => cmd !== 'xcrun' && args?.[0] === command,
      );
      expect(idbCalls).toHaveLength(1);
      // The companion was still replaced for the next command.
      expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
    },
  );

  it('resends a read-only command when delivery is uncertain', async () => {
    mockExecStrict
      .mockRejectedValueOnce(new Error('StatusCode.UNAVAILABLE'))
      .mockResolvedValueOnce('[]');

    await backend.snapshot();

    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'describe',
      async (): Promise<unknown> => backend.getDeviceInfo(),
      '{"name":"iPhone"}',
    ],
    [
      'list-apps',
      async (): Promise<unknown> => backend.getAppState('io.metamask'),
      '',
    ],
    [
      'screenshot',
      async (): Promise<unknown> =>
        backend.screenshot('/tmp/shot.png', { encode: false }),
      '',
    ],
    ['log', async (): Promise<unknown> => backend.getLogs(5), ''],
  ])(
    'resends read-only idb %s when delivery is uncertain',
    async (command, run, output) => {
      mockExecStrict
        .mockRejectedValueOnce(new Error('StatusCode.UNAVAILABLE'))
        .mockResolvedValueOnce(output);

      await run();

      const idbCalls = mockExecStrict.mock.calls.filter(
        ([, args]) => args?.[0] === command,
      );
      expect(idbCalls).toHaveLength(2);
      expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
    },
  );

  it('reports disposal during a command as an interruption, without a resend', async () => {
    await backend.ensureConnected();
    let fail!: (error: Error) => void;
    mockExecStrict.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const tapping = backend.tapCoordinates(1, 2).catch((e: unknown) => e);
    await vi.waitFor(() => expect(tapCalls()).toHaveLength(1));

    await backend.dispose();
    const cause = new Error(companionGone);
    fail(cause);
    const error = await tapping;

    expect(error).not.toBeInstanceOf(IdbUnavailableError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'IDB command interrupted: the backend was disposed during the call',
    );
    expect((error as Error).message).not.toContain(
      'idb_companion is installed',
    );
    expect((error as Error).cause).toBe(cause);
    expect(tapCalls()).toHaveLength(1);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(1);
  });

  it('does not resend when disposed after joining a newer companion', async () => {
    await backend.ensureConnected();
    let fail!: (error: Error) => void;
    mockExecStrict.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        fail = reject;
      }),
    );
    const tapping = backend.tapCoordinates(1, 2).catch((e: unknown) => e);
    await vi.waitFor(() => expect(tapCalls()).toHaveLength(1));
    // Another caller replaces the companion while the tap is in flight.
    await backend.reconnect();
    // Dispose exactly when the failed tap checks the new companion, so
    // ensureConnected() itself succeeds.
    let disposing: Promise<void> | undefined;
    Object.defineProperty(connectionState, 'alive', {
      configurable: true,
      get: (): boolean => {
        disposing ??= backend.dispose();
        return true;
      },
    });
    try {
      fail(new Error(hidInvalidated));
      expect(await tapping).toMatchObject({
        message:
          'IDB command interrupted: the backend was disposed during the call',
      });
      await disposing;
    } finally {
      Object.defineProperty(connectionState, 'alive', {
        configurable: true,
        writable: true,
        value: true,
      });
    }
    expect(disposing).toBeDefined();
    expect(tapCalls()).toHaveLength(1);
  });

  it('keeps the connect error when cleanup after a failed connect also fails', async () => {
    connectionMocks.connect.mockRejectedValueOnce(new Error('startup failed'));
    connectionMocks.dispose.mockRejectedValueOnce(new Error('stop failed'));

    await expect(backend.ensureConnected()).rejects.toThrow('startup failed');
    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a failed reconnect as IDB_COMPANION_UNAVAILABLE', async () => {
    await backend.ensureConnected();
    mockExecStrict.mockRejectedValue(new Error(hidInvalidated));
    connectionMocks.connect.mockRejectedValueOnce(
      new Error('Private IDB companion exited before readiness (1)'),
    );

    await expect(backend.tapCoordinates(1, 1)).rejects.toMatchObject({
      code: 'IDB_COMPANION_UNAVAILABLE',
      message: expect.stringContaining('exited before readiness'),
    });
    expect(tapCalls()).toHaveLength(1);
  });

  it('passes other failures through unchanged', async () => {
    mockExecStrict.mockRejectedValue(new Error('No such app io.metamask'));

    await expect(backend.tapCoordinates(1, 1)).rejects.toThrow(
      'No such app io.metamask',
    );
    expect(connectionMocks.connect).toHaveBeenCalledTimes(1);
  });

  const keyCalls = (key: string): unknown[][] =>
    mockExecStrict.mock.calls.filter(
      ([, args]) => args?.[1] === 'key' && args?.[2] === key,
    );

  it('resends the typeText clear when the HID connection was invalidated', async () => {
    await backend.ensureConnected();
    let failures = 1;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.[1] === 'key' && args?.[2] === '4' && failures > 0) {
        failures -= 1;
        throw new Error(hidInvalidated);
      }
      return '';
    });

    await backend.typeText('abc');

    // Command+A failed undelivered, was resent once on a fresh companion,
    // and the rest of the sequence ran.
    expect(keyCalls('4')).toHaveLength(2);
    expect(keyCalls('42')).toHaveLength(1);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it('rejects typeText instead of appending when the clear cannot be delivered', async () => {
    await backend.ensureConnected();
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.[1] === 'key' && args?.[2] === '42') {
        throw new Error('StatusCode.UNAVAILABLE');
      }
      return '';
    });

    await expect(backend.typeText('abc')).rejects.toMatchObject({
      code: 'IDB_COMPANION_UNAVAILABLE',
      message: expect.stringContaining('may have run'),
    });
    // Backspace is mutating with uncertain delivery: not resent, and the
    // text is never typed onto the old value.
    expect(keyCalls('42')).toHaveLength(1);
    expect(
      mockExecStrict.mock.calls.filter(([, args]) => args?.[1] === 'text'),
    ).toHaveLength(0);
  });

  it('shares one reconnect between concurrent failing calls', async () => {
    await backend.ensureConnected();
    let failures = 2;
    mockExecStrict.mockImplementation(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error(hidInvalidated);
      }
      return '';
    });

    await Promise.all([
      backend.tapCoordinates(1, 1),
      backend.tapCoordinates(2, 2),
    ]);

    expect(connectionMocks.dispose).toHaveBeenCalledTimes(1);
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
  });

  it('exposes reconnect() and refuses it after disposal', async () => {
    await backend.ensureConnected();
    await backend.reconnect();
    expect(connectionMocks.connect).toHaveBeenCalledTimes(2);
    await backend.dispose();
    await expect(backend.reconnect()).rejects.toThrow('disposed');
  });

  it('does not reconnect when disposed during a reconnect', async () => {
    await backend.ensureConnected();
    let release!: () => void;
    connectionMocks.dispose.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const reconnecting = backend.reconnect().catch((e: unknown) => e);
    await vi.waitFor(() => expect(release).toBeDefined());
    const disposing = backend.dispose();
    release();
    expect(await reconnecting).toMatchObject({
      message: expect.stringContaining('disposed'),
    });
    await disposing;
    expect(connectionMocks.connect).toHaveBeenCalledTimes(1);
  });
});
