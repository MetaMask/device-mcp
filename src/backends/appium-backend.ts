import type { SessionConfig } from './session-file.js';
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
  Platform,
} from './types.js';
import { WebDriverClient, createSession } from './webdriver-client.js';
import {
  findElement,
  describeElement,
  computeSwipeEnd,
} from '../utils/element.js';

export class AppiumBackend implements DeviceBackend {
  readonly platform: Platform;

  #client: WebDriverClient | null = null;

  readonly #config: SessionConfig;

  constructor(config: SessionConfig) {
    this.#config = config;
    this.platform = config.platform;
  }

  async ensureConnected(): Promise<void> {
    if (this.#client) {
      return;
    }

    if (this.#config.mode === 'attach') {
      this.#client = new WebDriverClient(
        this.#config.appiumUrl,
        this.#config.sessionId,
        this.#config.auth,
      );
      await this.#client.getStatus();
    } else {
      const { client } = await createSession(
        this.#config.appiumUrl,
        this.#config.capabilities,
        this.#config.auth,
      );
      this.#client = client;
    }
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const client = this.#requireClient();
    const details = await client.getSessionDetails();
    const caps = (details.capabilities ?? details) as Record<string, unknown>;

    return {
      platform: this.platform,
      deviceId: (caps.udid as string) ?? client.sessionId,
      name: (caps.deviceName as string) ?? 'Appium Device',
      osVersion: (caps.platformVersion as string) ?? 'Unknown',
      state: 'connected',
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    const client = this.#requireClient();
    const raw = await this.#getHierarchy(client);
    const hierarchy =
      this.platform === 'ios'
        ? parseAppiumIosHierarchy(raw)
        : parseAppiumAndroidHierarchy(raw);

    return {
      platform: this.platform,
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

    const targetX = Math.round(element.frame.x + element.frame.width / 2);
    const targetY = Math.round(element.frame.y + element.frame.height / 2);
    await this.tapCoordinates(targetX, targetY);

    return {
      success: true,
      x: targetX,
      y: targetY,
      targetDescription: describeElement(element),
    };
  }

  async tapCoordinates(targetX: number, targetY: number): Promise<void> {
    const client = this.#requireClient();
    await client.performActions([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: targetX, y: targetY },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 50 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await client.releaseActions();
  }

  async typeText(text: string): Promise<void> {
    const client = this.#requireClient();
    const activeElement = await client.findElement(
      'xpath',
      '//*[@focused="true"]',
    );
    const elementId = extractElementId(activeElement);
    await client.elementClear(elementId);
    await client.elementSendKeys(elementId, text);
  }

  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    const client = this.#requireClient();
    const dist = distance ?? 500;
    const sx = startX ?? 200;
    const sy = startY ?? 400;
    const [endX, endY] = computeSwipeEnd(sx, sy, direction, dist);

    await client.performActions([
      {
        type: 'pointer',
        id: 'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: sx, y: sy },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 300, x: endX, y: endY },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ]);
    await client.releaseActions();
  }

  async waitForElement(
    query: ElementQuery,
    timeoutMs = 10_000,
    intervalMs = 500,
  ): Promise<UIElement> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const snap = await this.snapshot();
      const element = findElement(snap.hierarchy, query);
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
    const client = this.#requireClient();

    if (this.platform === 'ios') {
      // iOS app state: 0=not installed, 1=not running, 2=background, 3=suspended, 4=foreground
      const state = await client.queryAppState(bundleId);
      const stateMap: Record<number, string> = {
        0: 'Not Installed',
        1: 'Not Running',
        2: 'Running (background)',
        3: 'Suspended',
        4: 'Running (foreground)',
      };
      return { bundleId, state: stateMap[state] ?? `Unknown (${state})` };
    }

    try {
      const activity = await client.getCurrentActivity();
      return { bundleId, state: `Running (${activity})` };
    } catch {
      return { bundleId, state: 'Not Running' };
    }
  }

  async #getHierarchy(client: WebDriverClient): Promise<string> {
    if (this.platform === 'ios') {
      return this.#getIosHierarchy(client);
    }
    return client.getPageSource();
  }

  async #getIosHierarchy(client: WebDriverClient): Promise<string> {
    // Limit hierarchy depth to avoid "JS stack is too deep" on complex iOS apps
    try {
      await client.updateSettings({ snapshotMaxDepth: 30 });
    } catch {
      // snapshotMaxDepth not supported on older XCUITest drivers
    }

    try {
      return await client.execute<string>('mobile: source', [
        { format: 'xml' },
      ]);
    } catch {
      return client.getPageSource();
    }
  }

  async screenshot(): Promise<ScreenshotResult> {
    const client = this.#requireClient();
    const data = await client.execute<string>('mobile: getScreenshot', []);
    return { data, format: 'png' };
  }

  async openApp(bundleId: string): Promise<void> {
    const client = this.#requireClient();
    await client.execute('mobile: activateApp', [{ bundleId }]);
  }

  async closeApp(bundleId: string): Promise<void> {
    const client = this.#requireClient();
    await client.execute('mobile: terminateApp', [{ bundleId }]);
  }

  async pressButton(button: DeviceButton): Promise<void> {
    const client = this.#requireClient();
    if (this.platform === 'ios') {
      const iosMap: Record<DeviceButton, string> = {
        home: 'home',
        lock: 'lock',
        back: 'home',
        enter: '\n',
      };
      await client.execute('mobile: pressButton', [{ name: iosMap[button] }]);
    } else {
      // Android keyevent codes
      const androidMap: Record<DeviceButton, number> = {
        home: 3,
        back: 4,
        enter: 66,
        lock: 26,
      };
      await client.execute('mobile: pressKey', [
        { keycode: androidMap[button] },
      ]);
    }
  }

  async dismissKeyboard(): Promise<void> {
    const client = this.#requireClient();
    if (this.platform === 'ios') {
      await client.execute('mobile: hideKeyboard', []);
    } else {
      await client.execute('mobile: hideKeyboard', []);
    }
  }

  async dismissAlert(accept: boolean): Promise<void> {
    const client = this.#requireClient();
    const action = accept ? 'accept' : 'dismiss';
    await client.execute(`mobile: ${action}Alert`, []);
  }

  async getLogs(durationSeconds = 30, filter?: string): Promise<LogsResult> {
    const client = this.#requireClient();
    const logType = this.platform === 'ios' ? 'syslog' : 'logcat';
    const raw = await client.execute<Record<string, unknown>[]>(
      'mobile: getLog',
      [{ type: logType }],
    );

    let entries = raw.map((entry) => ({
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      level: typeof entry.level === 'string' ? entry.level : 'info',
      message: typeof entry.message === 'string' ? entry.message : '',
    }));

    if (filter) {
      const pattern = new RegExp(filter, 'iu');
      entries = entries.filter((entry) => pattern.test(entry.message));
    }

    const cutoff = Date.now() - durationSeconds * 1000;
    entries = entries.filter((entry) => {
      const ts = Number(entry.timestamp);
      return isNaN(ts) || ts >= cutoff;
    });

    return { entries, source: `appium ${logType}` };
  }

  #requireClient(): WebDriverClient {
    if (!this.#client) {
      throw new Error(
        'AppiumBackend not connected. Call ensureConnected() first.',
      );
    }
    return this.#client;
  }
}

function extractElementId(element: Record<string, string>): string {
  // W3C uses 'element-6066-11e4-a52e-4f735466cecf', JSONWP uses 'ELEMENT'
  return (
    element['element-6066-11e4-a52e-4f735466cecf'] ||
    element.ELEMENT ||
    Object.values(element)[0] ||
    ''
  );
}

export function parseAppiumAndroidHierarchy(xml: string): UIElement[] {
  const elements: UIElement[] = [];
  const nodeRegex = /<node\s+([^>]+)\/?>/gu;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const element = parseAndroidNodeAttrs(match[1]);
    if (element) {
      elements.push(element);
    }
  }

  return elements;
}

function parseAndroidNodeAttrs(attrs: string): UIElement | null {
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

export function parseAppiumIosHierarchy(xml: string): UIElement[] {
  const elements: UIElement[] = [];
  // XCUITest XML uses <XCUIElementType* ...> elements
  const nodeRegex = /<(XCUIElementType\w+)\s+([^>]+)\/?>/gu;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const typeName = match[1];
    const element = parseIosNodeAttrs(typeName, match[2]);
    if (element) {
      elements.push(element);
    }
  }

  return elements;
}

function parseIosNodeAttrs(typeName: string, attrs: string): UIElement | null {
  const get = (name: string): string | undefined => {
    const attrMatch = attrs.match(new RegExp(`${name}="([^"]*)"`, 'u'));
    return attrMatch?.[1] || undefined;
  };

  const xStr = get('x');
  const yStr = get('y');
  const widthStr = get('width');
  const heightStr = get('height');

  if (!xStr || !yStr || !widthStr || !heightStr) {
    return null;
  }

  const shortType = typeName.replace(/^XCUIElementType/u, '');

  return {
    type: shortType,
    label: get('label') || undefined,
    value: get('value') || undefined,
    identifier: get('name') || undefined,
    frame: {
      x: parseInt(xStr, 10),
      y: parseInt(yStr, 10),
      width: parseInt(widthStr, 10),
      height: parseInt(heightStr, 10),
    },
    enabled: get('enabled') !== 'false',
  };
}
