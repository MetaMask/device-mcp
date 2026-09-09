import { execFile as execFileCb, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import type {
  DeviceBackend,
  DeviceButton,
  DeviceInfo,
  SnapshotResult,
  ScreenshotResult,
  ScreenshotFileResult,
  ScreenshotOptions,
  LogsResult,
  TapResult,
  AppStateResult,
  ElementQuery,
  UIElement,
  WindowSize,
} from './types.js';
import { ACCEPT_LABELS, DENY_LABELS } from '../utils/alert-labels.js';
import {
  findElement,
  describeElement,
  computeSwipeEnd,
} from '../utils/element.js';
import { execStrict, exec } from '../utils/exec.js';
import {
  hardenArtifactFile,
  resolveArtifactPath,
} from '../utils/output-path.js';
import {
  chooseAxApi,
  idbSupportsApiSelection,
  resolveIdbPath,
} from '../utils/platform.js';

export class IdbBackend implements DeviceBackend {
  readonly kind = 'idb' as const;

  readonly platform = 'ios' as const;

  #connected = false;

  readonly #udid: string;

  #idbPath = 'idb';

  #idbSupportsApi = false;

  #recordingProcess: ChildProcess | null = null;

  #recordingPath: string | null = null;

  constructor(udid: string) {
    this.#udid = udid;
  }

  async ensureConnected(): Promise<void> {
    if (this.#connected) {
      return;
    }

    this.#idbPath = await resolveIdbPath();
    this.#idbSupportsApi = await idbSupportsApiSelection(this.#idbPath);
    await exec(this.#idbPath, ['connect', this.#udid]);
    await this.#enableSimulatorAccessibility();
    this.#connected = true;
  }

  /**
   * Enable the simulator's software accessibility bridge, which `idb ui
   * describe-all` reads. React Native publishes its UI to this bridge; when
   * `ApplicationAccessibilityEnabled` is off, idb sees only native UIKit views
   * and an RN screen collapses to the app root node (a bottom sheet over it
   * appears as ~2 nodes). XCUITest backends avoid this because attaching a
   * test runner enables the bridge as a side effect; idb does not, so we set
   * it explicitly. The value is read when an app initializes accessibility, so
   * callers should launch/relaunch the app after connecting.
   */
  async #enableSimulatorAccessibility(): Promise<void> {
    try {
      await exec('xcrun', [
        'simctl',
        'spawn',
        this.#udid,
        'defaults',
        'write',
        'com.apple.Accessibility',
        'ApplicationAccessibilityEnabled',
        '-bool',
        'true',
      ]);
    } catch {
      // Best-effort: on hosts where the write is unavailable, keep the
      // connection usable for native views and coordinate taps.
    }
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    await this.ensureConnected();
    const raw = await execStrict(this.#idbPath, [
      'describe',
      '--udid',
      this.#udid,
      '--json',
    ]);
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `idb describe returned invalid JSON for device ${this.#udid}: ${raw.slice(0, 200)}`,
      );
    }
    return {
      platform: 'ios',
      deviceId: this.#udid,
      name: (info.name as string) ?? 'Unknown',
      osVersion: (info.os_version as string) ?? 'Unknown',
      state: (info.state as string) ?? 'Unknown',
    };
  }

  async snapshot(): Promise<SnapshotResult> {
    await this.ensureConnected();
    const raw = await this.#describeAll();
    const hierarchy = parseIdbHierarchy(raw);
    return {
      platform: 'ios',
      hierarchy,
      raw,
      timestamp: Date.now(),
    };
  }

  /**
   * Run `idb ui describe-all`, trying the version-appropriate accessibility
   * backend first and falling back to the others if it errors. This keeps
   * snapshots working across iOS 17-26 regardless of the user's idb client.
   *
   * @returns The raw JSON hierarchy from the first backend that succeeds.
   * @throws When every attempted backend fails.
   */
  async #describeAll(): Promise<string> {
    const apis = await this.#describeAllApiOrder();
    let lastError: unknown;
    for (const api of apis) {
      const args = ['ui', 'describe-all', '--udid', this.#udid];
      if (api !== null) {
        args.push('--api', api);
      }
      try {
        return await execStrict(this.#idbPath, args);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('idb ui describe-all failed for all accessibility backends');
  }

  /**
   * Ordered `--api` values to attempt: the version preference, then the
   * complement; or a single `null` (omit `--api`) when the CLI lacks support.
   *
   * @returns The ordered `--api` attempts.
   */
  async #describeAllApiOrder(): Promise<('ax' | 'axbridge' | null)[]> {
    if (!this.#idbSupportsApi) {
      return [null];
    }
    const { osVersion } = await this.getDeviceInfo();
    const preferred = chooseAxApi(osVersion, true);
    const complement = preferred === 'axbridge' ? 'ax' : 'axbridge';
    return [preferred, complement];
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

    const { x, y } = await this.#visibleTapPoint(element);
    await this.tapCoordinates(x, y);

    return {
      success: true,
      x,
      y,
      targetDescription: describeElement(element),
    };
  }

  /**
   * Returns the center of the part of the element's frame that lies inside
   * the device viewport, in logical points. Tapping there is safer than
   * tapping the raw frame center, which can fall outside the screen for
   * off-screen or partially scrolled elements and either hit nothing or an
   * unrelated on-screen control.
   *
   * @param element - The element to tap.
   * @returns The tap point in logical points.
   * @throws When the element's frame does not intersect the viewport at all.
   */
  async #visibleTapPoint(
    element: UIElement,
  ): Promise<{ x: number; y: number }> {
    const { width, height } = await this.getWindowSize();
    const x0 = Math.max(element.frame.x, 0);
    const y0 = Math.max(element.frame.y, 0);
    const x1 = Math.min(element.frame.x + element.frame.width, width);
    const y1 = Math.min(element.frame.y + element.frame.height, height);
    if (x1 <= x0 || y1 <= y0) {
      throw new Error(
        `Element is outside the ${width}x${height} viewport: ` +
          `${describeElement(element)} at (${element.frame.x}, ${element.frame.y} ` +
          `${element.frame.width}x${element.frame.height}). ` +
          'Scroll it into view first (device_swipe or scroll_to_element).',
      );
    }
    return {
      x: Math.round((x0 + x1) / 2),
      y: Math.round((y0 + y1) / 2),
    };
  }

  async getElementText(query: ElementQuery): Promise<string> {
    await this.ensureConnected();
    const snapshot = await this.snapshot();
    const element = findElement(snapshot.hierarchy, query);
    if (!element) {
      throw new Error(
        `Element not found: ${JSON.stringify(query)}\n` +
          'Use device_snapshot to inspect the current UI hierarchy.',
      );
    }
    return element.label ?? element.value ?? '';
  }

  async tapCoordinates(x: number, y: number): Promise<void> {
    await this.ensureConnected();
    await execStrict(this.#idbPath, [
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
    await exec(this.#idbPath, [
      'ui',
      'key-sequence',
      '--',
      'cmd+a',
      '--udid',
      this.#udid,
    ]);
    await exec(this.#idbPath, ['ui', 'key', 'DELETE', '--udid', this.#udid]);
    await execStrict(this.#idbPath, ['ui', 'text', text, '--udid', this.#udid]);
  }

  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    await this.ensureConnected();
    const { width, height } = await this.getWindowSize();
    const sx = startX ?? Math.round(width / 2);
    const sy = startY ?? Math.round(height / 2);
    // Without an explicit duration the idb client sends duration=0 and the
    // companion delivers the interpolated touch sequence as a zero-delay
    // burst, which iOS does not process as a scroll (it reads as a tap at the
    // start point). 0.3s mirrors the Android backend's `input swipe` duration.
    const durationSeconds = 0.3;
    // Default to 40% of the swipe-axis dimension so the default endpoint
    // stays clear of the screen edges on any supported device size.
    const d =
      distance ??
      Math.max(
        1,
        Math.round(
          (direction === 'up' || direction === 'down' ? height : width) * 0.4,
        ),
      );
    let [endX, endY] = computeSwipeEnd(sx, sy, direction, d);
    if (distance === undefined) {
      // The caller did not pin the endpoint; keep the computed one inside the
      // viewport even when explicit start coordinates leave little room.
      endX = Math.min(Math.max(endX, 1), width - 2);
      endY = Math.min(Math.max(endY, 1), height - 2);
    }

    await execStrict(this.#idbPath, [
      'ui',
      'swipe',
      String(sx),
      String(sy),
      String(endX),
      String(endY),
      '--duration',
      String(durationSeconds),
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
    try {
      const raw = await execStrict(this.#idbPath, [
        'list-apps',
        '--udid',
        this.#udid,
      ]);

      for (const line of raw.trim().split('\n')) {
        if (line.includes(bundleId)) {
          // `idb list-apps` rows are:
          // bundle_id | name | install_type | architectures |
          // process_state | debuggable | pid=<pid>
          // (the pid column is `pid=<n>` only when the app is running,
          // `pid=None` otherwise).
          const parts = line.split('|').map((s) => s.trim());
          const pidField = parts[6] ?? '';
          const pid = pidField.startsWith('pid=')
            ? Number.parseInt(pidField.slice(4), 10)
            : Number.NaN;
          return {
            bundleId,
            state: parts[4] ?? 'Unknown',
            pid: Number.isNaN(pid) ? undefined : pid,
          };
        }
      }

      return { bundleId, state: 'Not Installed' };
    } catch {
      return this.#getAppStateViaSimctl(bundleId);
    }
  }

  async #getAppStateViaSimctl(bundleId: string): Promise<AppStateResult> {
    const result = await exec('xcrun', ['simctl', 'listapps', this.#udid]);
    if (result.exitCode === 0 && result.stdout.includes(bundleId)) {
      return { bundleId, state: 'Running' };
    }
    return { bundleId, state: 'Not Installed' };
  }

  screenshot(
    outputPath?: string,
    options?: { encode?: true },
  ): Promise<ScreenshotResult>;

  screenshot(
    outputPath: string | undefined,
    options: { encode: false },
  ): Promise<ScreenshotFileResult>;

  screenshot(
    outputPath?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult | ScreenshotFileResult>;

  async screenshot(
    outputPath?: string,
    options?: ScreenshotOptions,
  ): Promise<ScreenshotResult | ScreenshotFileResult> {
    await this.ensureConnected();
    const path = resolveArtifactPath(outputPath, 'screenshot');
    await execStrict(this.#idbPath, ['screenshot', path, '--udid', this.#udid]);
    hardenArtifactFile(path);
    if (options?.encode === false) {
      return { data: undefined, format: 'png', path };
    }
    const data = await readFile(path, 'base64');
    return { data, format: 'png', path };
  }

  async openApp(bundleId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await execStrict(this.#idbPath, [
        'launch',
        bundleId,
        '--udid',
        this.#udid,
      ]);
    } catch {
      await execStrict('xcrun', ['simctl', 'launch', this.#udid, bundleId]);
    }
  }

  async closeApp(bundleId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await execStrict(this.#idbPath, [
        'terminate',
        bundleId,
        '--udid',
        this.#udid,
      ]);
    } catch {
      await execStrict('xcrun', ['simctl', 'terminate', this.#udid, bundleId]);
    }
  }

  async pressButton(button: DeviceButton): Promise<void> {
    await this.ensureConnected();
    const keyMap: Record<DeviceButton, string> = {
      home: 'HOME',
      lock: 'LOCK',
      back: 'HOME',
      enter: 'RETURN',
    };
    await execStrict(this.#idbPath, [
      'ui',
      'key',
      keyMap[button],
      '--udid',
      this.#udid,
    ]);
  }

  async dismissKeyboard(): Promise<void> {
    await this.ensureConnected();
    await execStrict(this.#idbPath, [
      'ui',
      'key',
      'RETURN',
      '--udid',
      this.#udid,
    ]);
  }

  async dismissAlert(accept: boolean): Promise<void> {
    await this.ensureConnected();
    const snap = await this.snapshot();
    const candidates = accept ? ACCEPT_LABELS : DENY_LABELS;

    for (const label of candidates) {
      const element = findElement(snap.hierarchy, { label });
      if (element) {
        const cx = Math.round(element.frame.x + element.frame.width / 2);
        const cy = Math.round(element.frame.y + element.frame.height / 2);
        await this.tapCoordinates(cx, cy);
        return;
      }
    }

    throw new Error(`No alert button found. Tried: ${candidates.join(', ')}`);
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
    const raw = await execStrict(this.#idbPath, args);
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

    const { x: cx, y: cy } = await this.#visibleTapPoint(element);
    await execStrict(this.#idbPath, [
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

  async scrollToElement(
    query: ElementQuery,
    direction: 'up' | 'down' = 'down',
    maxAttempts = 10,
  ): Promise<UIElement> {
    await this.ensureConnected();
    let previousRaw = '';

    for (let i = 0; i < maxAttempts; i++) {
      const snap = await this.snapshot();
      const element = findElement(snap.hierarchy, query);
      if (element) {
        return element;
      }
      if (snap.raw === previousRaw) {
        break;
      }
      previousRaw = snap.raw;
      await this.swipe(direction);
    }
    throw new Error(
      `Element not found after scrolling: ${JSON.stringify(query)}\n` +
        'Use device_snapshot to inspect the current UI hierarchy.',
    );
  }

  async getAlertText(): Promise<string> {
    await this.ensureConnected();
    const snap = await this.snapshot();
    const texts = collectAlertTexts(snap.hierarchy);
    if (texts.length === 0) {
      throw new Error(
        'No alert is currently displayed.\n' +
          'Use device_snapshot to inspect the current UI hierarchy.',
      );
    }
    return texts.join('\n');
  }

  async getWindowSize(): Promise<WindowSize> {
    await this.ensureConnected();
    const raw = await execStrict(this.#idbPath, [
      'describe',
      '--udid',
      this.#udid,
      '--json',
    ]);
    try {
      const info = JSON.parse(raw) as Record<string, unknown>;
      const dims = info.screen_dimensions as
        | {
            width?: number;
            height?: number;
            // eslint-disable-next-line @typescript-eslint/naming-convention -- idb wire field
            width_points?: number;
            // eslint-disable-next-line @typescript-eslint/naming-convention -- idb wire field
            height_points?: number;
          }
        | undefined;
      // Gestures and accessibility frames are in logical points, while
      // `width`/`height` are hardware pixels; prefer the point dimensions.
      if (dims?.width_points && dims?.height_points) {
        return { width: dims.width_points, height: dims.height_points };
      }
    } catch {
      // fall through to snapshot-based approach
    }
    const snap = await this.snapshot();
    if (snap.hierarchy.length > 0) {
      const root = snap.hierarchy[0];
      if (root.frame.width > 0 && root.frame.height > 0) {
        return { width: root.frame.width, height: root.frame.height };
      }
    }
    throw new Error('Unable to determine window size from device');
  }

  async getContexts(): Promise<string[]> {
    return ['NATIVE_APP'];
  }

  async setContext(context: string): Promise<void> {
    if (context === 'NATIVE_APP') {
      return;
    }
    throw new Error(
      'Context switching requires Appium backend. IDB only supports NATIVE_APP.',
    );
  }

  async getClipboard(): Promise<string> {
    await this.ensureConnected();
    return execStrict('xcrun', ['simctl', 'pbpaste', this.#udid]);
  }

  async setClipboard(text: string): Promise<void> {
    await this.ensureConnected();
    await new Promise<void>((resolve, reject) => {
      const proc = execFileCb(
        'xcrun',
        ['simctl', 'pbcopy', this.#udid],
        { timeout: 30_000 },
        (error) => (error ? reject(new Error(error.message)) : resolve()),
      );
      proc.stdin?.end(text);
    });
  }

  async startScreenRecording(outputPath?: string): Promise<void> {
    await this.ensureConnected();
    if (this.#recordingProcess) {
      throw new Error('Screen recording is already in progress');
    }
    const path = resolveArtifactPath(outputPath, 'recording');
    this.#recordingPath = path;
    this.#recordingProcess = spawn(this.#idbPath, [
      'record-video',
      path,
      '--udid',
      this.#udid,
    ]);
    this.#recordingProcess.on('error', () => {
      this.#recordingProcess = null;
      this.#recordingPath = null;
    });
  }

  async stopScreenRecording(): Promise<string> {
    if (!this.#recordingProcess || !this.#recordingPath) {
      throw new Error('No screen recording in progress');
    }
    const path = this.#recordingPath;
    this.#recordingProcess.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    this.#recordingProcess = null;
    this.#recordingPath = null;
    hardenArtifactFile(path);
    return path;
  }
}

function collectAlertTexts(elements: UIElement[]): string[] {
  const texts: string[] = [];
  for (const el of elements) {
    const isAlertContainer =
      el.type === 'Alert' || el.type === 'Sheet' || el.type.includes('Alert');
    if (isAlertContainer) {
      collectTextsFromChildren(el.children ?? [], texts);
      return texts;
    }
    if (el.children) {
      const found = collectAlertTexts(el.children);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return texts;
}

function collectTextsFromChildren(
  elements: UIElement[],
  texts: string[],
): void {
  for (const el of elements) {
    if (el.type === 'StaticText' || el.type === 'TextView') {
      const text = el.value ?? el.label;
      if (text) {
        texts.push(text);
      }
    }
    if (el.children) {
      collectTextsFromChildren(el.children, texts);
    }
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
