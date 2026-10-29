import { execFile as execFileCb, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { IdbConnection } from './idb-connection.js';
import { classifyIdbFailure, IdbUnavailableError } from './idb-errors.js';
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
import type { ExecResult } from '../utils/exec.js';
import {
  hardenArtifactFile,
  resolveArtifactPath,
} from '../utils/output-path.js';
import {
  chooseAxApi,
  idbSupportsApiSelection,
  idbSupportsNestedDescribe,
  resolveIdbPath,
} from '../utils/platform.js';
import { stopChildProcess } from '../utils/stop-child-process.js';

/**
 * USB HID keyboard usage IDs. `idb ui key` takes these integers, not key
 * names (idb 1.7: "argument key: invalid int value: 'RETURN'").
 */
const HID_KEY = {
  a: 4,
  return: 40,
  backspace: 42,
} as const;

/**
 * Whether the software keyboard is on screen: an element whose type is
 * exactly `Keyboard`. (React Native's `KeyboardControllerView` is a
 * full-screen container that is always present, so a substring match on the
 * type is wrong.)
 *
 * @param elements - The snapshot hierarchy.
 * @returns True when a keyboard element is present.
 */
function hasKeyboard(elements: UIElement[]): boolean {
  return elements.some(
    (element) =>
      element.type === 'Keyboard' ||
      (element.children !== undefined && hasKeyboard(element.children)),
  );
}

export class IdbBackend implements DeviceBackend {
  readonly kind = 'idb' as const;

  readonly platform = 'ios' as const;

  #connected = false;

  #connecting: Promise<void> | undefined;

  #disposed = false;

  #disposing: Promise<void> | undefined;

  #reconnecting: Promise<void> | undefined;

  #probed = false;

  /** Incremented on every successful connect; detects reconnects by others. */
  #generation = 0;

  readonly #connection: IdbConnection;

  readonly #udid: string;

  #idbPath = 'idb';

  #idbSupportsApi = false;

  #idbSupportsNested = false;

  #recordingProcess: ChildProcess | null = null;

  #recordingPath: string | null = null;

  #stoppingRecording: Promise<string> | undefined;

  constructor(udid: string) {
    this.#udid = udid;
    this.#connection = new IdbConnection(udid);
  }

  async ensureConnected(): Promise<void> {
    if (this.#disposed) {
      throw new Error('IDB backend has been disposed');
    }
    // Never start a second connection while a reconnect owns the companion.
    await this.#reconnecting?.catch(() => undefined);
    if (this.#connected && !this.#connection.alive) {
      // The private companion exited after readiness (crash, simulator
      // shutdown, idle shutdown, external kill). Start a fresh one.
      await this.reconnect();
      return;
    }
    if (this.#connected) {
      return;
    }

    this.#connecting ??= this.#connect();
    await this.#connecting;
    if (this.#disposed) {
      throw new Error('IDB backend has been disposed');
    }
  }

  /**
   * Replace this backend's private companion with a fresh one. Concurrent
   * callers share one reconnect. Only the companion owned by this backend is
   * stopped; shared companions and other sessions are not touched.
   */
  async reconnect(): Promise<void> {
    if (this.#disposed) {
      throw new Error('IDB backend has been disposed');
    }
    this.#reconnecting ??= (async (): Promise<void> => {
      await this.#connecting?.catch(() => undefined);
      this.#connected = false;
      this.#connecting = undefined;
      await this.#connection.dispose();
      if (this.#disposed) {
        return;
      }
      this.#connecting = this.#connect();
      await this.#connecting;
    })().finally(() => {
      this.#reconnecting = undefined;
    });
    await this.#reconnecting;
    if (this.#disposed) {
      throw new Error('IDB backend has been disposed');
    }
  }

  async #connect(): Promise<void> {
    try {
      if (!this.#probed) {
        this.#idbPath = await resolveIdbPath();
        [this.#idbSupportsApi, this.#idbSupportsNested] = await Promise.all([
          idbSupportsApiSelection(this.#idbPath),
          idbSupportsNestedDescribe(this.#idbPath),
        ]);
        this.#probed = true;
      }
      await this.#connection.connect(this.#idbPath);
      await this.#enableSimulatorAccessibility();
      this.#generation += 1;
      this.#connected = true;
    } catch (error) {
      // Best-effort cleanup: a failed stop must not hide the connect error.
      await this.#connection.dispose().catch(() => undefined);
      this.#connecting = undefined;
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposing ??= (async (): Promise<void> => {
      await this.#reconnecting?.catch(() => undefined);
      await this.#connecting?.catch(() => undefined);
      const errors: unknown[] = [];
      // Finalize the recording while its companion can still serve it.
      if (this.#recordingProcess) {
        await this.stopScreenRecording().catch((error: unknown) =>
          errors.push(error),
        );
      }
      await this.#connection
        .dispose()
        .catch((error: unknown) => errors.push(error));
      this.#connected = false;
      if (errors.length) {
        this.#disposing = undefined;
        throw new AggregateError(errors, 'IDB backend disposal failed');
      }
    })();
    await this.#disposing;
  }

  async #execStrict(command: string, args: string[]): Promise<string> {
    if (command !== this.#idbPath) {
      return execStrict(command, args);
    }
    return this.#idb(args, async () =>
      execStrict(command, args, { env: this.#connection.env }),
    );
  }

  /**
   * Run a non-idb command (`xcrun simctl ...`) and return its result without
   * throwing. Every idb command goes through `#execStrict`.
   *
   * @param command - The command to run.
   * @param args - Its arguments.
   * @returns The exit code and output.
   */
  async #exec(command: string, args: string[]): Promise<ExecResult> {
    return exec(command, args);
  }

  /**
   * Run one idb command through this backend's private companion and recover
   * once from a lost companion or an invalidated simulator HID connection:
   * classify the failure, start a fresh private companion, and send the
   * command once more.
   *
   * The companion refuses the HID event that hits an invalidated dtuhidd
   * connection, so that event was not delivered, and an unreachable companion
   * received nothing. When the HID connection was already stale (the observed
   * failure), the first event fails and the resend is safe. If the simulator
   * died partway through a multi-event command (`ui text`, `ui swipe`), a
   * leading part of it may already have landed. When delivery is uncertain
   * (`StatusCode.UNAVAILABLE`), only read-only commands are resent. A command
   * is never resent after the backend is disposed.
   *
   * @param args - The idb arguments (used to decide whether a resend is safe).
   * @param run - Sends the command once; rejects when it fails.
   * @returns The output of the first successful run.
   */
  async #idb(args: string[], run: () => Promise<string>): Promise<string> {
    if (!this.#connected || !this.#connection.alive) {
      // The companion died (or a reconnect failed) since this method's own
      // ensureConnected(); start a fresh one before sending.
      await this.ensureConnected();
    }
    const generation = this.#generation;
    const first = await attempt(run);
    const failure =
      first.text === undefined ? undefined : classifyIdbFailure(first.text);
    if (!failure) {
      return first.settle();
    }
    const resend = failure.notDelivered || !isMutatingIdbCommand(args);
    try {
      if (this.#generation === generation) {
        await this.reconnect();
      } else {
        // A concurrent call already replaced the companion; use the new one.
        await this.ensureConnected();
      }
    } catch (error) {
      if (this.#disposed) {
        throw interrupted(first);
      }
      throw new IdbUnavailableError(
        'IDB_COMPANION_UNAVAILABLE',
        this.#udid,
        error instanceof Error ? error.message : String(error),
        { cause: error, mayHaveRun: !resend },
      );
    }
    if (this.#disposed) {
      // Disposal started while another call's reconnect was finishing.
      throw interrupted(first);
    }
    if (!resend) {
      throw new IdbUnavailableError(
        failure.code,
        this.#udid,
        first.text ?? '',
        {
          cause: first.error,
          mayHaveRun: true,
        },
      );
    }
    const second = await attempt(run);
    const again =
      second.text === undefined ? undefined : classifyIdbFailure(second.text);
    if (!again) {
      return second.settle();
    }
    throw new IdbUnavailableError(again.code, this.#udid, second.text ?? '', {
      cause: second.error,
    });
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
      await this.#exec('xcrun', [
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
    const raw = await this.#execStrict(this.#idbPath, [
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
      if (this.#idbSupportsNested) {
        args.push('--nested');
      }
      try {
        return await this.#execStrict(this.#idbPath, args);
      } catch (error) {
        if (error instanceof IdbUnavailableError) {
          // Already reconnected and retried; another --api will not help.
          throw error;
        }
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
    await this.#execStrict(this.#idbPath, [
      'ui',
      'tap',
      String(x),
      String(y),
      '--udid',
      this.#udid,
    ]);
  }

  /**
   * Replaces the content of the focused text field with `text`.
   *
   * Clears first with select-all (Command+A) and Backspace, both through
   * strict execution so a failed clear rejects instead of appending to the
   * old value. On an empty field the two keys do nothing.
   *
   * @param text - The text to type.
   */
  async typeText(text: string): Promise<void> {
    await this.ensureConnected();
    await this.#execStrict(this.#idbPath, [
      'ui',
      'key',
      String(HID_KEY.a),
      '--command',
      '--udid',
      this.#udid,
    ]);
    await this.#execStrict(this.#idbPath, [
      'ui',
      'key',
      String(HID_KEY.backspace),
      '--udid',
      this.#udid,
    ]);
    await this.#execStrict(this.#idbPath, [
      'ui',
      'text',
      text,
      '--udid',
      this.#udid,
    ]);
  }

  async swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
    await this.ensureConnected();
    const windowSize = await this.getWindowSize();
    await this.#swipe(direction, windowSize, startX, startY, distance);
  }

  async #swipe(
    direction: 'up' | 'down' | 'left' | 'right',
    { width, height }: WindowSize,
    startX?: number,
    startY?: number,
    distance?: number,
  ): Promise<void> {
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

    await this.#execStrict(this.#idbPath, [
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
      const raw = await this.#execStrict(this.#idbPath, [
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
    const result = await this.#exec('xcrun', [
      'simctl',
      'listapps',
      this.#udid,
    ]);
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
    await this.#execStrict(this.#idbPath, [
      'screenshot',
      path,
      '--udid',
      this.#udid,
    ]);
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
      await this.#execStrict(this.#idbPath, [
        'launch',
        bundleId,
        '--udid',
        this.#udid,
      ]);
    } catch {
      await this.#execStrict('xcrun', [
        'simctl',
        'launch',
        this.#udid,
        bundleId,
      ]);
    }
  }

  async closeApp(bundleId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.#execStrict(this.#idbPath, [
        'terminate',
        bundleId,
        '--udid',
        this.#udid,
      ]);
    } catch {
      await this.#execStrict('xcrun', [
        'simctl',
        'terminate',
        this.#udid,
        bundleId,
      ]);
    }
  }

  /**
   * `home` and `lock` are hardware buttons (`idb ui button`); `enter` is the
   * Return key (`idb ui key 40`). iOS has no back button.
   *
   * @param button - The button to press.
   * @throws `UNSUPPORTED_ON_IOS` for `back`, which iOS does not have.
   */
  async pressButton(button: DeviceButton): Promise<void> {
    if (button === 'back') {
      throw Object.assign(
        new Error(
          "UNSUPPORTED_ON_IOS: iOS has no back button. Tap the screen's own " +
            'back control (usually top left) instead.',
        ),
        { code: 'UNSUPPORTED_ON_IOS' },
      );
    }
    await this.ensureConnected();
    const args =
      button === 'enter'
        ? ['ui', 'key', String(HID_KEY.return)]
        : ['ui', 'button', button === 'home' ? 'HOME' : 'LOCK'];
    await this.#execStrict(this.#idbPath, [...args, '--udid', this.#udid]);
  }

  /**
   * Hides the software keyboard by pressing Return, and does nothing when no
   * keyboard is shown. Return can also submit a single-field form.
   */
  async dismissKeyboard(): Promise<void> {
    await this.ensureConnected();
    const { hierarchy } = await this.snapshot();
    if (!hasKeyboard(hierarchy)) {
      return;
    }
    await this.#execStrict(this.#idbPath, [
      'ui',
      'key',
      String(HID_KEY.return),
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
    const raw = await this.#execStrict(this.#idbPath, args);
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
    await this.#execStrict(this.#idbPath, [
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
    const windowSize = await this.getWindowSize();
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
      await this.#swipe(direction, windowSize);
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
    const raw = await this.#execStrict(this.#idbPath, [
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
    return this.#execStrict('xcrun', ['simctl', 'pbpaste', this.#udid]);
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
    this.#recordingProcess = spawn(
      this.#idbPath,
      ['record-video', path, '--udid', this.#udid],
      { env: this.#connection.env },
    );
    this.#recordingProcess.on('error', () => {
      this.#recordingProcess = null;
      this.#recordingPath = null;
    });
    this.#recordingProcess.stdout?.resume();
    this.#recordingProcess.stderr?.resume();
  }

  async stopScreenRecording(): Promise<string> {
    if (this.#stoppingRecording) {
      return this.#stoppingRecording;
    }
    if (!this.#recordingProcess || !this.#recordingPath) {
      throw new Error('No screen recording in progress');
    }
    const path = this.#recordingPath;
    const child = this.#recordingProcess;
    this.#stoppingRecording = (async (): Promise<string> => {
      await stopChildProcess(child, 'SIGINT');
      this.#recordingProcess = null;
      this.#recordingPath = null;
      hardenArtifactFile(path);
      return path;
    })();
    try {
      return await this.#stoppingRecording;
    } finally {
      this.#stoppingRecording = undefined;
    }
  }
}

type Attempt<Result> = {
  text: string | undefined;
  error: unknown;
  settle: () => Result;
};

async function attempt<Result>(
  run: () => Promise<Result>,
): Promise<Attempt<Result>> {
  try {
    const value = await run();
    return { text: undefined, error: undefined, settle: () => value };
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      error,
      settle: (): never => {
        throw error;
      },
    };
  }
}

/**
 * The error for a failed first attempt when the backend was disposed before
 * the recovery could run. Disposal is a teardown, not a device fault, so the
 * command is not resent and no device remediation is given.
 *
 * @param first - The failed first attempt.
 * @returns The error to throw.
 */
function interrupted<Result>(first: Attempt<Result>): Error {
  return new Error(
    'IDB command interrupted: the backend was disposed during the call',
    { cause: first.error },
  );
}

/** Top-level idb commands that only read device state. */
const READ_ONLY_COMMANDS = new Set([
  'describe',
  'list-apps',
  'screenshot',
  'log',
]);

/** `idb ui` subcommands that only read device state. */
const READ_ONLY_UI_COMMANDS = new Set([
  'describe-all',
  'describe-point',
  'describe',
  'wait',
]);

/**
 * Whether an idb command can change the device (a resend could repeat it).
 * Only commands listed as read-only are safe; any other command, including
 * one added later, counts as mutating.
 *
 * @param args - The idb arguments.
 * @returns False only for known read-only commands.
 */
function isMutatingIdbCommand(args: string[]): boolean {
  const [command = '', subcommand = ''] = args;
  if (command === 'ui') {
    return !READ_ONLY_UI_COMMANDS.has(subcommand);
  }
  return !READ_ONLY_COMMANDS.has(command);
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

/**
 * Parse flat or nested idb output. Legacy object roots expose their children
 * at the top level; array roots keep their tree shape.
 *
 * @param raw - The raw stdout of `idb ui describe-all`.
 * @returns The hierarchy, or a `raw` element when parsing fails.
 */
export function parseIdbHierarchy(raw: string): UIElement[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(mapIdbElement);
    }
    if (Array.isArray(parsed.children) && parsed.children.length > 0) {
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

/**
 * Normalize idb fields, treating empty child arrays like flat-format leaves.
 *
 * @param node - The idb node.
 * @returns The mapped element.
 */
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
    children:
      Array.isArray(node.children) && node.children.length > 0
        ? node.children.map(mapIdbElement)
        : undefined,
  };
}
