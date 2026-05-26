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
import { execStrict, exec, isCommandAvailable } from '../utils/exec.js';

export class IdbBackend implements DeviceBackend {
  readonly platform = 'ios' as const;

  #connected = false;

  readonly #udid: string;

  constructor(udid: string) {
    this.#udid = udid;
  }

  async ensureConnected(): Promise<void> {
    if (this.#connected) {
      return;
    }

    if (!(await isCommandAvailable('idb'))) {
      throw new Error(
        'idb is not installed.\n' +
          'Install: brew tap facebook/fb && brew install idb-companion && pip3 install fb-idb',
      );
    }

    await exec('idb', ['connect', this.#udid]);
    this.#connected = true;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    await this.ensureConnected();
    const raw = await execStrict('idb', [
      'describe',
      '--udid',
      this.#udid,
      '--json',
    ]);
    const info = JSON.parse(raw);
    return {
      platform: 'ios',
      deviceId: this.#udid,
      name: info.name ?? 'Unknown',
      osVersion: info.os_version ?? 'Unknown',
      state: info.state ?? 'Unknown',
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    await this.ensureConnected();
    const raw = await execStrict('idb', [
      'ui',
      'describe-all',
      '--udid',
      this.#udid,
    ]);
    const hierarchy = parseIdbHierarchy(raw);
    return {
      platform: 'ios',
      hierarchy,
      raw,
      timestamp: Date.now(),
    };
  }

  async tapElement(query: ElementQuery): Promise<TapResult> {
    await this.ensureConnected();
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
    await this.ensureConnected();
    await execStrict('idb', [
      'ui',
      'tap',
      String(x),
      String(y),
      '--udid',
      this.#udid,
    ]);
  }

  async typeText(text: string): Promise<void> {
    await this.ensureConnected();
    await execStrict('idb', ['ui', 'text', text, '--udid', this.#udid]);
  }

  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    await this.ensureConnected();
    const d = distance ?? 500;
    const sx = startX ?? 200;
    const sy = startY ?? 400;
    const [endX, endY] = computeSwipeEnd(sx, sy, direction, d);

    await execStrict('idb', [
      'ui',
      'swipe',
      String(sx),
      String(sy),
      String(endX),
      String(endY),
      '--udid',
      this.#udid,
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
    await this.ensureConnected();
    const raw = await execStrict('idb', ['list-apps', '--udid', this.#udid]);

    for (const line of raw.trim().split('\n')) {
      if (line.includes(bundleId)) {
        const parts = line.split('|').map((s) => s.trim());
        return {
          bundleId,
          state: parts[2] ?? 'Unknown',
          pid: parts[3] ? parseInt(parts[3], 10) : undefined,
        };
      }
    }

    return { bundleId, state: 'Not Installed' };
  }

  async screenshot(outputPath?: string): Promise<ScreenshotResult> {
    await this.ensureConnected();
    const path = outputPath ?? `/tmp/device-mcp-screenshot-${Date.now()}.png`;
    await execStrict('idb', ['screenshot', path, '--udid', this.#udid]);
    const data = await execStrict('base64', [path]);
    return { data: data.trim(), format: 'png', path };
  }

  async openApp(bundleId: string): Promise<void> {
    await this.ensureConnected();
    await execStrict('idb', ['launch', bundleId, '--udid', this.#udid]);
  }

  async closeApp(bundleId: string): Promise<void> {
    await this.ensureConnected();
    await execStrict('idb', ['terminate', bundleId, '--udid', this.#udid]);
  }

  async pressButton(button: DeviceButton): Promise<void> {
    await this.ensureConnected();
    const keyMap: Record<DeviceButton, string> = {
      home: 'HOME',
      lock: 'LOCK',
      back: 'HOME',
      enter: 'RETURN',
    };
    await execStrict('idb', [
      'ui',
      'key',
      keyMap[button],
      '--udid',
      this.#udid,
    ]);
  }

  async dismissKeyboard(): Promise<void> {
    await this.ensureConnected();
    await execStrict('idb', ['ui', 'key', 'RETURN', '--udid', this.#udid]);
  }

  async dismissAlert(accept: boolean): Promise<void> {
    await this.ensureConnected();
    const snapshot = await this.snapshot();
    const buttonQuery = accept
      ? { label: 'Allow' }
      : { label: 'Don\u2019t Allow' };
    const fallbackQuery = accept ? { label: 'OK' } : { label: 'Cancel' };

    const element =
      findElement(snapshot.hierarchy, buttonQuery) ||
      findElement(snapshot.hierarchy, fallbackQuery);

    if (element) {
      const cx = Math.round(element.frame.x + element.frame.width / 2);
      const cy = Math.round(element.frame.y + element.frame.height / 2);
      await this.tapCoordinates(cx, cy);
    } else {
      throw new Error(
        `No alert button found. Looked for "${buttonQuery.label}" and "${fallbackQuery.label}"`,
      );
    }
  }

  async getLogs(durationSeconds = 30, filter?: string): Promise<LogsResult> {
    await this.ensureConnected();
    const args = [
      'log',
      '--udid',
      this.#udid,
      '--',
      '--last',
      `${durationSeconds}s`,
    ];
    if (filter) {
      args.push('--predicate', `eventMessage CONTAINS "${filter}"`);
    }
    const raw = await execStrict('idb', args);
    const entries = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => ({
        timestamp: line.substring(0, 31).trim(),
        level: 'info',
        message: line.substring(31).trim(),
      }));
    return { entries, source: 'idb log' };
  }

  async longPress(query: ElementQuery, durationMs = 1000): Promise<TapResult> {
    await this.ensureConnected();
    const snap = await this.snapshot();
    const element = findElement(snap.hierarchy, query);
    if (!element) {
      throw new Error(
        `Element not found: ${JSON.stringify(query)}\n` +
          'Use device_snapshot to inspect the current UI hierarchy.',
      );
    }

    const cx = Math.round(element.frame.x + element.frame.width / 2);
    const cy = Math.round(element.frame.y + element.frame.height / 2);
    await execStrict('idb', [
      'ui',
      'tap',
      String(cx),
      String(cy),
      '--duration',
      String(durationMs / 1000),
      '--udid',
      this.#udid,
    ]);

    return {
      success: true,
      x: cx,
      y: cy,
      targetDescription: describeElement(element),
    };
  }
}

export function parseIdbHierarchy(raw: string): UIElement[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(mapIdbElement);
    }
    if (parsed.children) {
      return parsed.children.map(mapIdbElement);
    }
    return [mapIdbElement(parsed)];
  } catch {
    return [
      {
        type: 'raw',
        label: raw.slice(0, 200),
        frame: { x: 0, y: 0, width: 0, height: 0 },
        enabled: true,
      },
    ];
  }
}

export function mapIdbElement(node: Record<string, unknown>): UIElement {
  const frame = node.frame as
    | { x: number; y: number; width: number; height: number }
    | undefined;

  return {
    type: (node.type as string) ?? (node.AXType as string) ?? 'Unknown',
    label: (node.AXLabel as string) ?? (node.label as string) ?? undefined,
    value: (node.AXValue as string) ?? (node.value as string) ?? undefined,
    identifier:
      (node.AXUniqueId as string) ?? (node.identifier as string) ?? undefined,
    frame: frame ?? { x: 0, y: 0, width: 0, height: 0 },
    enabled: (node.enabled as boolean) ?? true,
    children: Array.isArray(node.children)
      ? node.children.map(mapIdbElement)
      : undefined,
  };
}
