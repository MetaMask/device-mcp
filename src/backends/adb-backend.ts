import type {
  DeviceBackend,
  DeviceButton,
  DeviceInfo,
  SnapshotResult,
  ScreenshotResult,
  LogsResult,
  TapResult,
  AppStateResult,
  ElementQuery,
  UIElement,
} from './types.js';
import {
  findElement,
  describeElement,
  computeSwipeEnd,
} from '../utils/element.js';
import { execStrict, isCommandAvailable } from '../utils/exec.js';

export class AdbBackend implements DeviceBackend {
  readonly platform = 'android' as const;

  readonly #serial: string;

  constructor(serial: string) {
    this.#serial = serial;
  }

  async #adb(args: string[]): Promise<string> {
    return execStrict('adb', ['-s', this.#serial, ...args]);
  }

  async ensureConnected(): Promise<void> {
    if (!(await isCommandAvailable('adb'))) {
      throw new Error(
        'adb is not installed or not on $PATH.\n' +
          'Install Android SDK platform-tools.',
      );
    }
    const state = await this.#adb(['get-state']);
    if (state.trim() !== 'device') {
      throw new Error(
        `Device ${this.#serial} is not ready (state: ${state.trim()})`,
      );
    }
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const [model, version] = await Promise.all([
      this.#adb(['shell', 'getprop', 'ro.product.model']),
      this.#adb(['shell', 'getprop', 'ro.build.version.release']),
    ]);
    return {
      platform: 'android',
      deviceId: this.#serial,
      name: model.trim(),
      osVersion: version.trim(),
      state: 'device',
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    const raw = await this.#dumpUiHierarchy();
    const hierarchy = parseAndroidHierarchy(raw);
    return {
      platform: 'android',
      hierarchy,
      raw,
      timestamp: Date.now(),
    };
  }

  async tapElement(query: ElementQuery): Promise<TapResult> {
    const snapshot = await this.snapshot();
    const element = findElement(snapshot.hierarchy, query);
    if (!element) {
      throw new Error(
        `Element not found: ${JSON.stringify(query)}\n` +
          'Use device_snapshot to inspect the current UI hierarchy.',
      );
    }

    const x = Math.round(element.frame.x + element.frame.width / 2);
    const y = Math.round(element.frame.y + element.frame.height / 2);
    await this.tapCoordinates(x, y);

    return {
      success: true,
      x,
      y,
      targetDescription: describeElement(element),
    };
  }

  async tapCoordinates(x: number, y: number): Promise<void> {
    await this.#adb(['shell', 'input', 'tap', String(x), String(y)]);
  }

  async typeText(text: string): Promise<void> {
    // Android input text requires escaping spaces and special chars
    const escaped = text.replace(/ /gu, '%s').replace(/[&|;<>]/gu, '\\$&');
    await this.#adb(['shell', 'input', 'text', escaped]);
  }

  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    const d = distance ?? 500;
    const sx = startX ?? 540;
    const sy = startY ?? 960;
    const [endX, endY] = computeSwipeEnd(sx, sy, direction, d);
    const durationMs = 300;

    await this.#adb([
      'shell',
      'input',
      'swipe',
      String(sx),
      String(sy),
      String(endX),
      String(endY),
      String(durationMs),
    ]);
  }

  async waitForElement(
    query: ElementQuery,
    timeoutMs = 10_000,
    intervalMs = 500,
  ): Promise<UIElement> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snapshot = await this.snapshot();
      const element = findElement(snapshot.hierarchy, query);
      if (element) {
        return element;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
      `Timed out waiting for element: ${JSON.stringify(query)} (${timeoutMs}ms)`,
    );
  }

  async getAppState(bundleId: string): Promise<AppStateResult> {
    const raw = await this.#adb(['shell', 'dumpsys', 'activity', 'processes']);

    const pidMatch = raw.match(
      new RegExp(`PID #(\\d+):.*${bundleId.replace(/\./gu, '\\.')}`, 'u'),
    );

    if (pidMatch) {
      return {
        bundleId,
        state: 'Running',
        pid: parseInt(pidMatch[1], 10),
      };
    }

    const pmResult = await this.#adb([
      'shell',
      'pm',
      'list',
      'packages',
      bundleId,
    ]);
    if (pmResult.includes(bundleId)) {
      return { bundleId, state: 'Installed (not running)' };
    }

    return { bundleId, state: 'Not Installed' };
  }

  async #dumpUiHierarchy(): Promise<string> {
    const remotePath = '/sdcard/window_dump.xml';
    await this.#adb(['shell', 'uiautomator', 'dump', remotePath]);
    const xml = await this.#adb(['shell', 'cat', remotePath]);
    await this.#adb(['shell', 'rm', '-f', remotePath]);
    return xml;
  }

  async screenshot(outputPath?: string): Promise<ScreenshotResult> {
    const localPath =
      outputPath ?? `/tmp/device-mcp-screenshot-${Date.now()}.png`;
    await this.#adb(['shell', 'screencap', '-p', '/sdcard/screenshot.png']);
    await execStrict('adb', [
      '-s',
      this.#serial,
      'pull',
      '/sdcard/screenshot.png',
      localPath,
    ]);
    await this.#adb(['shell', 'rm', '-f', '/sdcard/screenshot.png']);
    const data = await execStrict('base64', [localPath]);
    return { data: data.trim(), format: 'png', path: localPath };
  }

  async openApp(bundleId: string): Promise<void> {
    await this.#adb([
      'shell',
      'monkey',
      '-p',
      bundleId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  }

  async closeApp(bundleId: string): Promise<void> {
    await this.#adb(['shell', 'am', 'force-stop', bundleId]);
  }

  async pressButton(button: DeviceButton): Promise<void> {
    // Android keyevent codes
    const keyMap: Record<DeviceButton, string> = {
      home: '3',
      back: '4',
      enter: '66',
      lock: '26',
    };
    await this.#adb(['shell', 'input', 'keyevent', keyMap[button]]);
  }

  async dismissKeyboard(): Promise<void> {
    await this.#adb(['shell', 'input', 'keyevent', '111']);
  }

  async dismissAlert(accept: boolean): Promise<void> {
    const snapshot = await this.snapshot();
    const buttonQuery = accept ? { text: 'Allow' } : { text: 'Deny' };
    const fallbackQuery = accept ? { text: 'OK' } : { text: 'Cancel' };

    const element =
      findElement(snapshot.hierarchy, buttonQuery) ||
      findElement(snapshot.hierarchy, fallbackQuery);

    if (element) {
      const cx = Math.round(element.frame.x + element.frame.width / 2);
      const cy = Math.round(element.frame.y + element.frame.height / 2);
      await this.tapCoordinates(cx, cy);
    } else {
      throw new Error(
        `No alert button found. Looked for "${buttonQuery.text}" and "${fallbackQuery.text}"`,
      );
    }
  }

  async getLogs(durationSeconds = 30, filter?: string): Promise<LogsResult> {
    const args = ['shell', 'logcat', '-d', '-t', String(durationSeconds)];
    if (filter) {
      args.push('-e', filter);
    }
    const raw = await this.#adb(args);
    const entries = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d{2}-\d{2}\s+\S+)\s+(\w)\/.*?:\s*(.*)/u);
        if (match) {
          return {
            timestamp: match[1],
            level: match[2],
            message: match[3],
          };
        }
        return { timestamp: '', level: 'info', message: line };
      });
    return { entries, source: 'logcat' };
  }
}

export function parseAndroidHierarchy(xml: string): UIElement[] {
  const elements: UIElement[] = [];
  const nodeRegex = /<node\s+([^>]+)\/?>/gu;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const element = parseNodeAttributes(attrs);
    if (element) {
      elements.push(element);
    }
  }

  return elements;
}

export function parseNodeAttributes(attrs: string): UIElement | null {
  const get = (name: string): string | undefined => {
    const attrMatch = attrs.match(new RegExp(`${name}="([^"]*)"`, 'u'));
    return attrMatch?.[1] || undefined;
  };

  const boundsStr = get('bounds');
  if (!boundsStr) {
    return null;
  }

  // bounds format: [x1,y1][x2,y2]
  const boundsMatch = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/u);
  if (!boundsMatch) {
    return null;
  }

  const x1 = parseInt(boundsMatch[1], 10);
  const y1 = parseInt(boundsMatch[2], 10);
  const x2 = parseInt(boundsMatch[3], 10);
  const y2 = parseInt(boundsMatch[4], 10);

  return {
    type: get('class') ?? 'Unknown',
    label: get('content-desc') || undefined,
    value: get('text') || undefined,
    identifier: get('resource-id') || undefined,
    frame: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
    enabled: get('enabled') !== 'false',
  };
}
