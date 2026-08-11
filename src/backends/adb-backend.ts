import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { exec, execStrict, isCommandAvailable } from '../utils/exec.js';
import {
  hardenArtifactFile,
  resolveArtifactPath,
} from '../utils/output-path.js';

/**
 * `uiautomator dump` exits 0 and prints its success banner even when it fails
 * outright, and its "could not get idle state" error is not reliably delivered
 * over `adb shell`. The XML payload is therefore the only trustworthy signal, so
 * every dump is validated and retried before being surfaced as an error.
 */
const DUMP_ATTEMPTS = 3;

const DUMP_RETRY_DELAY_MS = 750;

// uiautomator waits internally for an idle window before giving up, which can
// exceed the default exec timeout.
const DUMP_TIMEOUT_MS = 60_000;

// Writable by the shell user without scoped-storage restrictions.
const DUMP_REMOTE_DIR = '/data/local/tmp';

/**
 * Check that a dump produced real hierarchy XML rather than an error banner, a
 * truncated write, or an empty file.
 *
 * Only the root element is required. A screen with no dumpable nodes is a valid
 * (if unusual) result, and must stay distinguishable from a failed dump so that
 * callers report "element not found" rather than a capture failure.
 *
 * @param xml - Raw stdout captured from the dumped file.
 * @returns True when the payload is hierarchy XML.
 */
function isValidHierarchyXml(xml: string): boolean {
  return xml.includes('<hierarchy');
}

/**
 * Build a single-line diagnostic from a dump's output streams.
 *
 * @param stderr - Standard error captured from the dump.
 * @param stdout - Standard output captured from the dump.
 * @returns A description of why the dump was rejected.
 */
function summarizeDumpOutput(stderr: string, stdout: string): string {
  const detail = [stderr, stdout]
    .map((stream) => stream.trim())
    .filter(Boolean)
    .join(' | ');
  return detail
    ? `uiautomator produced no usable hierarchy (${detail})`
    : 'uiautomator produced no usable hierarchy';
}

/**
 * Pick remediation advice that matches how the dump actually failed, so an
 * unreachable device is not misreported as an animation problem.
 *
 * @param failures - The collected per-attempt failure details.
 * @returns Actionable guidance for the caller.
 */
function describeDumpRemediation(failures: string): string {
  const detail = failures.toLowerCase();

  if (detail.includes('not found') || detail.includes('device offline')) {
    return (
      'The device was unreachable during the dump. Confirm it is still connected ' +
      'with `adb devices` and that the serial is correct.'
    );
  }

  return (
    'The most common cause is that uiautomator never observed an idle window ' +
    '("ERROR: could not get idle state."), which means something on screen is ' +
    'animating or redrawing continuously.\n' +
    'Things to check:\n' +
    '  - Disable animations: adb shell settings put global window_animation_scale 0 ' +
    '(also transition_animation_scale and animator_duration_scale).\n' +
    '  - Animation scales do NOT stop JS-driven React Native animations ' +
    '(Animated.loop with useNativeDriver: false), indeterminate ProgressBars, ' +
    'shimmer/skeleton loaders, or video/SurfaceView playback. Look for one of those ' +
    'on the current screen and use device_screenshot to confirm what is on it.'
  );
}

export class AdbBackend implements DeviceBackend {
  readonly kind = 'adb' as const;

  readonly platform = 'android' as const;

  readonly #serial: string;

  #recordingProcess: ChildProcess | null = null;

  #recordingPath: string | null = null;

  readonly #recordingRemotePath = '/sdcard/device-mcp-recording.mp4';

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

  async getElementText(query: ElementQuery): Promise<string> {
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
    await this.#adb(['shell', 'input', 'tap', String(x), String(y)]);
  }

  async typeText(text: string): Promise<void> {
    // Android keyevent 29+shift = Ctrl+A (select all), 67 = DEL
    await this.#adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_HOME']);
    await this.#adb([
      'shell',
      'input',
      'keyevent',
      '--longpress',
      'KEYCODE_SHIFT_LEFT',
      'KEYCODE_MOVE_END',
    ]);
    await this.#adb(['shell', 'input', 'keyevent', '67']);
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
    const failures: string[] = [];

    for (let attempt = 1; attempt <= DUMP_ATTEMPTS; attempt++) {
      // A unique path per attempt is required for correctness, not hygiene: on a
      // shared path a failed dump leaves the previous attempt's file in place, so
      // the following `cat` silently returns the hierarchy of an earlier screen.
      const remotePath = `${DUMP_REMOTE_DIR}/device-mcp-dump-${randomUUID()}.xml`;

      try {
        const dump = await exec(
          'adb',
          ['-s', this.#serial, 'shell', 'uiautomator', 'dump', remotePath],
          { timeoutMs: DUMP_TIMEOUT_MS },
        );
        const xml = await this.#adb(['shell', 'cat', remotePath]);

        if (isValidHierarchyXml(xml)) {
          return xml;
        }

        failures.push(
          `attempt ${attempt}: ${summarizeDumpOutput(dump.stderr, dump.stdout)}`,
        );
      } catch (error) {
        failures.push(
          `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Never let cleanup mask the dump outcome.
        await this.#adb(['shell', 'rm', '-f', remotePath]).catch(
          () => undefined,
        );
      }

      if (attempt < DUMP_ATTEMPTS) {
        await new Promise((resolve) => {
          setTimeout(resolve, DUMP_RETRY_DELAY_MS * attempt);
        });
      }
    }

    const detail = failures.join('\n');
    throw new Error(
      `uiautomator failed to capture the UI hierarchy after ${DUMP_ATTEMPTS} attempts.\n${detail}\n${describeDumpRemediation(detail)}`,
    );
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
    const localPath = resolveArtifactPath(outputPath, 'screenshot');
    // Unique per capture so a failed screencap can never be pulled as a stale
    // image from an earlier call.
    const remotePath = `${DUMP_REMOTE_DIR}/device-mcp-screenshot-${randomUUID()}.png`;
    try {
      await this.#adb(['shell', 'screencap', '-p', remotePath]);
      await execStrict('adb', [
        '-s',
        this.#serial,
        'pull',
        remotePath,
        localPath,
      ]);
    } finally {
      await this.#adb(['shell', 'rm', '-f', remotePath]).catch(() => undefined);
    }
    hardenArtifactFile(localPath);
    if (options?.encode === false) {
      return { data: undefined, format: 'png', path: localPath };
    }
    const data = await readFile(localPath, 'base64');
    return { data, format: 'png', path: localPath };
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
    const snap = await this.snapshot();
    const candidates = accept ? ACCEPT_LABELS : DENY_LABELS;

    for (const label of candidates) {
      const element = findElement(snap.hierarchy, { text: label });
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

  async longPress(query: ElementQuery, durationMs = 1000): Promise<TapResult> {
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
    await this.#adb([
      'shell',
      'input',
      'swipe',
      String(cx),
      String(cy),
      String(cx),
      String(cy),
      String(durationMs),
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
    const snap = await this.snapshot();
    const texts = collectAndroidAlertTexts(snap.hierarchy);
    if (texts.length === 0) {
      throw new Error(
        'No alert is currently displayed.\n' +
          'Use device_snapshot to inspect the current UI hierarchy.',
      );
    }
    return texts.join('\n');
  }

  async getWindowSize(): Promise<WindowSize> {
    const raw = await this.#adb(['shell', 'wm', 'size']);
    const match = raw.match(/(\d+)x(\d+)/u);
    if (match) {
      return {
        width: parseInt(match[1], 10),
        height: parseInt(match[2], 10),
      };
    }
    throw new Error(`Unable to parse window size from: ${raw.trim()}`);
  }

  async getContexts(): Promise<string[]> {
    return ['NATIVE_APP'];
  }

  async setContext(context: string): Promise<void> {
    if (context === 'NATIVE_APP') {
      return;
    }
    throw new Error(
      'Context switching requires Appium backend. ADB only supports NATIVE_APP.',
    );
  }

  async getClipboard(): Promise<string> {
    throw new Error(
      'Clipboard access via ADB is not supported on modern Android. ' +
        'Use the Appium backend for clipboard operations.',
    );
  }

  async setClipboard(_text: string): Promise<void> {
    throw new Error(
      'Clipboard access via ADB is not supported on modern Android. ' +
        'Use the Appium backend for clipboard operations.',
    );
  }

  async startScreenRecording(outputPath?: string): Promise<void> {
    if (this.#recordingProcess) {
      throw new Error('Screen recording is already in progress');
    }
    this.#recordingPath = resolveArtifactPath(outputPath, 'recording');
    this.#recordingProcess = spawn('adb', [
      '-s',
      this.#serial,
      'shell',
      'screenrecord',
      this.#recordingRemotePath,
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
    const localPath = this.#recordingPath;
    this.#recordingProcess.kill('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    this.#recordingProcess = null;
    this.#recordingPath = null;

    await execStrict('adb', [
      '-s',
      this.#serial,
      'pull',
      this.#recordingRemotePath,
      localPath,
    ]);
    await this.#adb(['shell', 'rm', '-f', this.#recordingRemotePath]);
    hardenArtifactFile(localPath);
    return localPath;
  }
}

function collectAndroidAlertTexts(elements: UIElement[]): string[] {
  const texts: string[] = [];
  for (const el of elements) {
    const isDialog =
      el.type.includes('Dialog') || el.type.includes('AlertDialog');
    if (isDialog) {
      collectTextValues(el.children ?? [], texts);
      return texts;
    }
    if (el.children) {
      const found = collectAndroidAlertTexts(el.children);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return texts;
}

function collectTextValues(elements: UIElement[], texts: string[]): void {
  for (const el of elements) {
    if (el.type.includes('TextView') && el.value) {
      texts.push(el.value);
    }
    if (el.children) {
      collectTextValues(el.children, texts);
    }
  }
}

export function parseAndroidHierarchy(xml: string): UIElement[] {
  const stack: UIElement[][] = [[]];

  // Matches all <node ...>, </node>, and <node .../> tags in document order
  const tagRegex = /<(\/?)node(?:\s+([^>]*?))?\s*(\/?)>/gu;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const attrs = match[2];
    const isSelfClosing = match[3] === '/';

    if (isClosing) {
      if (stack.length > 1) {
        stack.pop();
      }
    } else if (isSelfClosing && attrs) {
      const element = parseNodeAttributes(attrs);
      if (element) {
        stack[stack.length - 1].push(element);
      }
    } else if (attrs) {
      const element = parseNodeAttributes(attrs);
      if (element) {
        element.children = [];
        stack[stack.length - 1].push(element);
        stack.push(element.children);
      }
    }
  }

  return stack[0];
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
