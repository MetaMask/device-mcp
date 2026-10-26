import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';

import {
  forwardWebViewSocket,
  listWebViewSockets,
  removeWebViewForward,
  resolvePackagePids,
  selectWebViewSocket,
} from './adb-forward.js';
import { loadHelperArtifact } from './android-instrumentation/artifact.js';
import {
  isHelperIncompleteCaptureError,
  isHelperNotInstalledError,
  isUntrustedHelperError,
} from './android-instrumentation/errors.js';
import {
  assertInstalledHelperTrusted,
  ensureHelperInstalled,
  HelperTrustCache,
  INSTRUMENTATION_NOT_FOUND_SIGNATURE,
} from './android-instrumentation/installer.js';
import {
  HELPER_INSTRUMENTATION,
  reassembleInstrumentationXml,
} from './android-instrumentation/snapshot.js';
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
  WebViewCdpInput,
  WebViewCdpOutcome,
} from './types.js';
import { runWebViewCdp } from './webview-cdp.js';
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

// `uiautomator dump` exits 0 and prints its success banner even when it fails, so
// the XML payload is the only trustworthy signal.
const DUMP_ATTEMPTS = 3;

const DUMP_RETRY_DELAY_MS = 750;

// Healthy dumps take ~150ms-2s, and even a failing one returns in ~2s.
const DUMP_TIMEOUT_MS = 15_000;

// Caps all attempts plus backoff, so worst case does not scale with retries.
const DUMP_DEADLINE_MS = 25_000;

// Writable by the shell user without scoped-storage restrictions.
const DUMP_REMOTE_DIR = '/data/local/tmp';

// The instrumentation helper skips uiautomator's idle wait, so it must be
// bounded by its own timeout rather than relying on "eventually idle".
const INSTRUMENT_TIMEOUT_MS = 8_000;

// `am instrument` streams the whole hierarchy as base64 status records; a deep
// tree can produce a few hundred KB, so raise the exec buffer above the default
// 10MB guard to keep an overflow from masquerading as a helper crash.
const INSTRUMENT_MAX_BUFFER = 16 * 1024 * 1024;

// In `auto` mode, try a single fast uiautomator dump first (it wins instantly
// on idle screens) before paying for the instrumentation path.
const AUTO_PROBE_DUMP_ATTEMPTS = 1;

// The shipped helper waits at most 500 ms for the foreground window's root
// (hard-coded in the APK), so a screen transition can make it report
// "Capture did not stabilize". That is transient: retry the helper this many
// more times, after a short pause, before any dump fallback.
const HELPER_INCOMPLETE_RETRIES = 2;

const HELPER_INCOMPLETE_RETRY_DELAY_MS = 250;

// Do not start a helper retry with less than this left before the deadline
// (the helper run itself is bounded to at least 1 s).
const HELPER_RETRY_MIN_REMAINING_MS = 1_000;

// In `helper-first`, once the helper actually ran on the device and failed,
// the screen is likely busy, where each `uiautomator dump` attempt waits about
// 11 s for an idle state and then fails. Cap the dump fallback at one attempt
// so the snapshot fails fast instead of burning the whole deadline.
const HELPER_FIRST_FALLBACK_DUMP_ATTEMPTS = 1;

/**
 * How `#dumpUiHierarchy` chooses between the uiautomator dump and the
 * instrumentation helper.
 *
 * - `helper-first` (default when the bundled helper APK is present): the
 *   helper first, then the dump retries as a last resort for non-trust helper
 *   failures. A trust failure never falls back to dump.
 * - `auto`: one quick dump, then the helper, then the remaining dump retries.
 *   Sticky per backend: once the quick dump failed and the helper succeeded,
 *   later snapshots skip the quick dump.
 * - `instrument`: helper only, fully fail-closed (no dump fallback).
 * - `dump`: stock uiautomator dump only (the original behavior). This is the
 *   default when the bundled helper APK is missing.
 */
export type AdbSnapshotMode = 'helper-first' | 'auto' | 'instrument' | 'dump';

const SNAPSHOT_MODES: readonly AdbSnapshotMode[] = [
  'helper-first',
  'auto',
  'instrument',
  'dump',
];

/** Which capture path produced a snapshot. */
type CaptureSource = 'dump' | 'instrument';

type Capture = { xml: string; source: CaptureSource };

export type AdbBackendOptions = {
  /**
   * The snapshot strategy. Takes precedence over the `DEVICE_MCP_ADB_SNAPSHOT`
   * environment variable. When neither is set, the backend uses `helper-first`
   * if the bundled helper APK is available, else `dump`.
   */
  snapshotMode?: AdbSnapshotMode;
};

/**
 * Narrow an arbitrary value to a snapshot mode.
 *
 * @param value - The candidate value.
 * @returns True when `value` is a known snapshot mode.
 */
function isSnapshotMode(value: unknown): value is AdbSnapshotMode {
  return SNAPSHOT_MODES.includes(value as AdbSnapshotMode);
}

/**
 * Read the snapshot mode from the environment.
 *
 * @returns The configured mode, or undefined for unset/unknown values.
 */
function readSnapshotModeFromEnv(): AdbSnapshotMode | undefined {
  const raw = process.env.DEVICE_MCP_ADB_SNAPSHOT?.trim().toLowerCase();
  return isSnapshotMode(raw) ? raw : undefined;
}

/**
 * Check that a dump produced complete hierarchy XML.
 *
 * `<hierarchy` alone sits at the start of the file, so requiring the closing tag
 * too is what rejects a truncated write before it reaches the tolerant regex
 * parser. An empty screen still emits a complete root, keeping "no elements"
 * distinguishable from a failed capture.
 *
 * @param xml - Raw stdout captured from the dumped file.
 * @returns True when the payload is complete hierarchy XML.
 */
function isValidHierarchyXml(xml: string): boolean {
  return xml.includes('<hierarchy') && xml.includes('</hierarchy>');
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

  // Optimistic per-process cache: once the helper is confirmed installed we
  // skip the `pm list packages` probe on every snapshot. A mid-session
  // uninstall/reboot is recovered reactively when `am instrument` reports the
  // instrumentation is missing.
  #helperInstalled = false;

  // Per-backend state for the signer check. It remembers which installed APK
  // paths last passed full verification, so a snapshot only re-pulls and
  // re-hashes the helper when `pm path` reports a different install. It is NOT
  // a "trusted" boolean: `pm path` still runs before every `am instrument`.
  readonly #helperTrust = new HelperTrustCache();

  // Serializes snapshot captures so overlapping `am instrument` runs (e.g. a
  // tap that triggers a nested snapshot) do not race on the single helper.
  #captureQueue: Promise<unknown> = Promise.resolve();

  readonly #snapshotModeOption: AdbSnapshotMode | undefined;

  // The default mode depends on whether the bundled helper APK is present. It
  // cannot change while the process runs, so resolve it once per backend.
  #defaultSnapshotMode: Promise<AdbSnapshotMode> | null = null;

  // `auto` mode only: set when the quick dump failed and the helper then
  // succeeded, so later snapshots skip the quick dump (it costs ~11 s on a
  // busy screen before it fails). Reset when the helper fails and the dump
  // fallback succeeds.
  #autoSkipQuickDump = false;

  // No stored WebView "active context": webviewCdp re-enumerates the live
  // devtools sockets on every call, so there is no per-context state to keep.
  /**
   * @param serial - The adb device serial.
   * @param options - Optional backend settings.
   * @param options.snapshotMode - The snapshot strategy. Takes precedence over
   * `DEVICE_MCP_ADB_SNAPSHOT`.
   */
  constructor(serial: string, options: AdbBackendOptions = {}) {
    if (
      options.snapshotMode !== undefined &&
      !isSnapshotMode(options.snapshotMode)
    ) {
      throw new Error(
        `Unknown ADB snapshot mode "${String(options.snapshotMode)}". ` +
          `Expected one of: ${SNAPSHOT_MODES.join(', ')}.`,
      );
    }
    this.#serial = serial;
    this.#snapshotModeOption = options.snapshotMode;
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
    const { capture, captureMs } = await this.#serializeCapture(async () => {
      // Time the capture itself, not the wait for an earlier capture.
      const start = Date.now();
      const result = await this.#dumpUiHierarchy();
      return { capture: result, captureMs: Date.now() - start };
    });
    const hierarchy = parseAndroidHierarchy(capture.xml);
    return {
      platform: 'android',
      hierarchy,
      raw: capture.xml,
      timestamp: Date.now(),
      source: capture.source,
      captureMs,
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

  /**
   * Run a capture after any in-flight capture completes, so concurrent
   * snapshots never overlap an `am instrument` run on the shared helper.
   *
   * @param capture - The capture operation to serialize.
   * @returns The capture result.
   */
  async #serializeCapture<Result>(
    capture: () => Promise<Result>,
  ): Promise<Result> {
    const run = this.#captureQueue.then(capture, capture);
    this.#captureQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Resolve the snapshot mode for this capture.
   *
   * Precedence: the `snapshotMode` constructor option, then
   * `DEVICE_MCP_ADB_SNAPSHOT`, then the default. The default is `helper-first`
   * when the bundled helper APK is available, else `dump` (for example a local
   * build without the APK), so a missing artifact never costs a failed helper
   * attempt on every snapshot.
   *
   * @returns The snapshot mode.
   */
  async #resolveSnapshotMode(): Promise<AdbSnapshotMode> {
    const explicit = this.#snapshotModeOption ?? readSnapshotModeFromEnv();
    if (explicit) {
      return explicit;
    }
    // The promise is cached per backend, so the warning prints once per
    // backend. It goes to stderr: an MCP stdio server must keep stdout clean.
    this.#defaultSnapshotMode ??= loadHelperArtifact().then(
      (): AdbSnapshotMode => 'helper-first',
      (error: unknown): AdbSnapshotMode => {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `adb snapshot: the bundled snapshot helper is unavailable (${reason}). ` +
            "Using snapshot mode 'dump'. Set snapshotMode or " +
            'DEVICE_MCP_ADB_SNAPSHOT to choose a mode explicitly.',
        );
        return 'dump';
      },
    );
    return this.#defaultSnapshotMode;
  }

  async #dumpUiHierarchy(): Promise<Capture> {
    const mode = await this.#resolveSnapshotMode();
    const failures: string[] = [];
    const deadline = Date.now() + DUMP_DEADLINE_MS;

    if (mode === 'dump') {
      const xml = await this.#tryDumpViaUiautomator(
        deadline,
        DUMP_ATTEMPTS,
        failures,
      );
      if (xml !== null) {
        return { xml, source: 'dump' };
      }
      throw new Error(this.#composeDumpFailure(failures));
    }

    // auto: a single fast dump wins instantly on idle screens. Skip it once it
    // has lost to the helper on this backend: on a busy screen it waits ~11 s
    // for an idle state that never comes.
    let quickDumpFailed = false;
    if (mode === 'auto' && !this.#autoSkipQuickDump) {
      const quick = await this.#tryDumpViaUiautomator(
        deadline,
        AUTO_PROBE_DUMP_ATTEMPTS,
        failures,
      );
      if (quick !== null) {
        return { xml: quick, source: 'dump' };
      }
      quickDumpFailed = true;
    }

    // All helper modes share installation, trust checks, and recovery. A trust
    // failure throws out of here and never reaches the dump fallback.
    const helper = await this.#dumpViaInstrumentation(deadline, failures);
    if (helper.xml !== null) {
      if (quickDumpFailed) {
        this.#autoSkipQuickDump = true;
      }
      return { xml: helper.xml, source: 'instrument' };
    }

    if (mode === 'instrument') {
      // Fully fail-closed: no dump fallback for any helper failure.
      throw new Error(this.#composeDumpFailure(failures));
    }

    // The dump retries are the last resort for a non-trust helper failure, so
    // a helper-side problem never leaves us worse than the stock dump. In
    // helper-first, a helper that ran and still failed points to a busy screen,
    // so the dump gets one attempt instead of three.
    const fallbackAttempts =
      mode === 'helper-first' && helper.ran
        ? HELPER_FIRST_FALLBACK_DUMP_ATTEMPTS
        : DUMP_ATTEMPTS;
    const fallback = await this.#tryDumpViaUiautomator(
      deadline,
      fallbackAttempts,
      failures,
    );
    if (fallback !== null) {
      // The helper is not working on this device right now, so give the quick
      // dump its chance again on the next `auto` snapshot.
      this.#autoSkipQuickDump = false;
      return { xml: fallback, source: 'dump' };
    }

    throw new Error(this.#composeDumpFailure(failures));
  }

  /**
   * Capture the hierarchy with the instrumentation helper, installing it first
   * when needed.
   *
   * Retries, all within the snapshot deadline:
   * - an incomplete capture ("Capture did not stabilize"): up to
   *   {@link HELPER_INCOMPLETE_RETRIES} more runs after a short pause;
   * - a missing helper (uninstalled mid-session): one reinstall, then a run.
   *
   * A trust failure is never retried: it propagates at once (fail closed).
   *
   * @param deadline - Absolute time (ms) the overall snapshot must finish by.
   * @param failures - Accumulator for diagnostic messages across dump paths.
   * @returns The hierarchy XML, or null when the helper path could not produce
   * a valid capture (the caller then may fall back to uiautomator dump), and
   * whether `am instrument` ran on the device at least once.
   */
  async #dumpViaInstrumentation(
    deadline: number,
    failures: string[],
  ): Promise<{ xml: string | null; ran: boolean }> {
    const run = { ran: false };
    let reinstalled = false;
    let incompleteRetries = 0;

    for (;;) {
      try {
        const xml = await this.#runInstrumentation(deadline, run);
        if (isValidHierarchyXml(xml)) {
          return { xml, ran: run.ran };
        }
        failures.push(
          reinstalled
            ? 'instrument: output was not complete hierarchy XML after reinstall'
            : 'instrument: output was not complete hierarchy XML',
        );
        break;
      } catch (error) {
        // A signer-trust failure means a possibly-malicious app squats the
        // helper's package name. Fail closed: propagate, never retry, never
        // fall back to dump.
        if (isUntrustedHelperError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);

        // The foreground window's root was briefly missing (for example during
        // a screen transition). Pause and run the helper again.
        if (
          isHelperIncompleteCaptureError(error) &&
          incompleteRetries < HELPER_INCOMPLETE_RETRIES &&
          deadline - Date.now() >
            HELPER_INCOMPLETE_RETRY_DELAY_MS + HELPER_RETRY_MIN_REMAINING_MS
        ) {
          incompleteRetries += 1;
          failures.push(
            `instrument: ${message} (retry ${incompleteRetries}/${HELPER_INCOMPLETE_RETRIES})`,
          );
          await new Promise((resolve) => {
            setTimeout(resolve, HELPER_INCOMPLETE_RETRY_DELAY_MS);
          });
          continue;
        }

        // A mid-session uninstall/reboot invalidates the optimistic install
        // cache. It shows up either before `am instrument` (`pm path` finds no
        // package: HelperNotInstalledError, not a trust failure) or from
        // `am instrument` itself. Retry once through the ensure-install path;
        // the fresh install is signer-verified in full before it runs.
        const helperMissing =
          !reinstalled &&
          (isHelperNotInstalledError(error) ||
            (this.#helperInstalled &&
              message.includes(INSTRUMENTATION_NOT_FOUND_SIGNATURE)));
        if (helperMissing) {
          reinstalled = true;
          this.#helperInstalled = false;
          this.#helperTrust.forget();
          continue;
        }

        failures.push(`instrument: ${message}`);
        break;
      }
    }
    return { xml: null, ran: run.ran };
  }

  /**
   * Ensure the helper is installed, then run it and reassemble its output.
   *
   * @param deadline - Absolute time (ms) the overall snapshot must finish by.
   * @param run - Set to `ran: true` once `am instrument` is started.
   * @param run.ran - Whether `am instrument` has run.
   * @returns The reassembled hierarchy XML.
   */
  async #runInstrumentation(
    deadline: number,
    run: { ran: boolean },
  ): Promise<string> {
    if (!this.#helperInstalled) {
      // Install/upgrade the helper by versionCode. Safe to cache per process:
      // the install is idempotent and NOT a trust decision.
      await ensureHelperInstalled(this.#serial);
      this.#helperInstalled = true;
    }

    // Trust invariant: re-check the installed helper BEFORE EVERY am instrument,
    // never cached as a boolean. Package name / versionCode are
    // attacker-controlled, so an actor who can install packages could swap a
    // previously-trusted helper for a malicious same-package instrumentation
    // between snapshots. Caching a "trusted" boolean would degrade the
    // signature pin to a one-time check. Instead `pm path` runs on every use,
    // and the pull + hash run again whenever the installed APK paths differ
    // from the last verified install. Any reinstall or update gets a new
    // randomized /data/app directory (API 26+), so a swap always changes the
    // path; replacing bytes at the same path needs root, which is out of the
    // threat model. Throws UntrustedHelperError on a signer mismatch (caller
    // fails closed).
    await assertInstalledHelperTrusted(this.#serial, this.#helperTrust);

    const remainingMs = deadline - Date.now();
    const timeoutMs = Math.max(
      1_000,
      Math.min(INSTRUMENT_TIMEOUT_MS, remainingMs),
    );

    run.ran = true;
    const { stdout } = await exec(
      'adb',
      [
        '-s',
        this.#serial,
        'shell',
        'am',
        'instrument',
        '-w',
        '-e',
        'waitForIdleTimeoutMs',
        '0',
        '-e',
        'timeoutMs',
        String(timeoutMs),
        HELPER_INSTRUMENTATION,
      ],
      // Bound the exec above the helper's own timeout, and raise the buffer so
      // a large tree is not misreported as a crash.
      { timeoutMs: timeoutMs + 5_000, maxBuffer: INSTRUMENT_MAX_BUFFER },
    );

    return reassembleInstrumentationXml(stdout);
  }

  /**
   * Run the uiautomator dump retry loop, swallowing failure into null.
   *
   * @param deadline - Absolute time (ms) the overall snapshot must finish by.
   * @param maxAttempts - How many dump attempts to make.
   * @param failures - Accumulator for diagnostic messages across dump paths.
   * @returns The hierarchy XML, or null when every attempt failed.
   */
  async #tryDumpViaUiautomator(
    deadline: number,
    maxAttempts: number,
    failures: string[],
  ): Promise<string | null> {
    try {
      return await this.#dumpViaUiautomator(deadline, maxAttempts, failures);
    } catch {
      // Failures are already recorded in the accumulator.
      return null;
    }
  }

  /**
   * The stock `uiautomator dump` capture with bounded retries.
   *
   * `uiautomator dump` exits 0 and prints its success banner even when it fails,
   * so the XML payload is the only trustworthy signal.
   *
   * @param deadline - Absolute time (ms) the overall snapshot must finish by.
   * @param maxAttempts - How many dump attempts to make.
   * @param failures - Accumulator for diagnostic messages across dump paths.
   * @returns The hierarchy XML.
   * @throws If every attempt failed to produce complete hierarchy XML.
   */
  async #dumpViaUiautomator(
    deadline: number,
    maxAttempts: number,
    failures: string[],
  ): Promise<string> {
    const startFailures = failures.length;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        failures.push(
          `dump attempt ${attempt}: skipped, ${DUMP_DEADLINE_MS}ms budget exhausted`,
        );
        break;
      }

      // Unique per attempt: on a shared path a failed dump leaves the previous
      // file behind, so `cat` silently returns an earlier screen's hierarchy.
      const remotePath = `${DUMP_REMOTE_DIR}/device-mcp-dump-${randomUUID()}.xml`;

      try {
        const dump = await exec(
          'adb',
          ['-s', this.#serial, 'shell', 'uiautomator', 'dump', remotePath],
          // Never outlive the overall deadline.
          { timeoutMs: Math.min(DUMP_TIMEOUT_MS, remainingMs) },
        );
        const xml = await this.#adb(['shell', 'cat', remotePath]);

        if (isValidHierarchyXml(xml)) {
          return xml;
        }

        failures.push(
          `dump attempt ${attempt}: ${summarizeDumpOutput(dump.stderr, dump.stdout)}`,
        );
      } catch (error) {
        failures.push(
          `dump attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        // Never let cleanup mask the dump outcome.
        await this.#adb(['shell', 'rm', '-f', remotePath]).catch(
          () => undefined,
        );
      }

      const backoffMs = DUMP_RETRY_DELAY_MS * attempt;
      if (attempt < maxAttempts && Date.now() + backoffMs < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, backoffMs);
        });
      }
    }

    const attemptCount = failures.length - startFailures;
    throw new Error(
      `uiautomator failed to capture the UI hierarchy after ${attemptCount} attempts.`,
    );
  }

  /**
   * Build the final error when every snapshot path has failed.
   *
   * @param failures - The collected per-path failure details.
   * @returns A single actionable error message.
   */
  #composeDumpFailure(failures: string[]): string {
    const detail = failures.join('\n');
    const remediation = describeDumpRemediation(detail);
    return `Failed to capture the UI hierarchy.\n${detail}\n${remediation}`;
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
    const sockets = await listWebViewSockets(async (args) =>
      this.#adb(args),
    ).catch(() => []);
    if (sockets.length === 0) {
      return ['NATIVE_APP'];
    }
    return ['NATIVE_APP', 'WEBVIEW'];
  }

  async setContext(context: string): Promise<void> {
    if (context === 'NATIVE_APP' || context.startsWith('WEBVIEW')) {
      return;
    }
    throw new Error(
      `Unknown context "${context}". ADB supports NATIVE_APP and WEBVIEW.`,
    );
  }

  /**
   * Runs a Chrome DevTools Protocol command against a debuggable in-app
   * WebView. Enumerates the WebView devtools socket, forwards it to an
   * ephemeral local TCP port, runs the command, and always removes the forward
   * afterwards. Independent of the Hermes/Metro CDP path.
   *
   * @param input - The CDP method, params, timeout, and optional page url
   * filter.
   * @returns The discriminated WebView CDP outcome.
   */
  async webviewCdp(input: WebViewCdpInput): Promise<WebViewCdpOutcome> {
    const adb = async (args: string[]): Promise<string> => this.#adb(args);
    const sockets = await listWebViewSockets(adb);
    const appPids = await resolvePackagePids(adb, this.#webviewPackage());
    const selection = selectWebViewSocket(sockets, appPids);
    if (!selection.ok) {
      return {
        ok: false,
        code:
          selection.reason === 'none'
            ? 'WEBVIEW_SOCKET_NOT_FOUND'
            : 'WEBVIEW_SOCKET_AMBIGUOUS',
        message: selection.message,
      };
    }
    if (selection.warning) {
      console.error(`webview_cdp: ${selection.warning}`);
    }

    const localPort = await this.#allocateLocalPort();
    try {
      await forwardWebViewSocket(adb, localPort, selection.name);
      return await runWebViewCdp({
        method: input.method,
        params: input.params,
        timeoutMs: input.timeoutMs,
        localPort,
        urlFilter: input.urlFilter,
      });
    } finally {
      await removeWebViewForward(adb, localPort);
    }
  }

  /**
   * Resolves the app package used to disambiguate WebView renderer sockets.
   *
   * @returns The configured WebView package name.
   */
  #webviewPackage(): string {
    return process.env.DEVICE_MCP_WEBVIEW_PACKAGE?.trim() || 'io.metamask';
  }

  /**
   * Reserves a free ephemeral local TCP port for an `adb forward`.
   *
   * @returns A currently-free local port number.
   */
  async #allocateLocalPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        server.close(() => resolve(port));
      });
    });
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

/**
 * Parse uiautomator / helper hierarchy XML into a `UIElement` tree.
 *
 * The parser is a tolerant tag scanner, not a full XML parser, so it keeps the
 * nesting balanced explicitly: every opening `<node>` pushes exactly one stack
 * frame and every `</node>` pops exactly one. A non-self-closing node whose
 * attributes cannot be parsed (missing or malformed `bounds`) still pushes a
 * placeholder frame that points at its parent's children array. Its children
 * then attach to the nearest parsed ancestor (the subtree is kept), and its
 * `</node>` pops the placeholder instead of the parent. Without the
 * placeholder, every later sibling is attached one level too high.
 *
 * @param xml - The raw hierarchy XML.
 * @returns The top-level elements (one per captured window root).
 */
export function parseAndroidHierarchy(xml: string): UIElement[] {
  const roots: UIElement[] = [];
  // Each frame is the children array that nodes at that depth attach to. A
  // placeholder frame for an unparseable node reuses its parent's array.
  const stack: UIElement[][] = [roots];

  // Matches all <node ...>, </node>, and <node .../> tags in document order
  const tagRegex = /<(\/?)node(?:\s+([^>]*?))?\s*(\/?)>/gu;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(xml)) !== null) {
    const isClosing = match[1] === '/';
    const attrs = match[2];
    const isSelfClosing = match[3] === '/';
    const parent = stack[stack.length - 1];

    if (isClosing) {
      if (stack.length > 1) {
        stack.pop();
      }
      continue;
    }

    const element = attrs ? parseNodeAttributes(attrs) : null;

    if (element) {
      if (!isSelfClosing) {
        element.children = [];
      }
      parent.push(element);
    }
    if (!isSelfClosing) {
      stack.push(element?.children ?? parent);
    }
  }

  return roots;
}

/**
 * Parse the attributes of a single `<node>` tag.
 *
 * Bounds may be negative (for example a view translated off screen) and may be
 * inverted (`x2 < x1` or `y2 < y1`, for example a view below the fold that
 * Android clips to the window). Width and height are clamped to 0 so a frame
 * never has a negative size.
 *
 * @param attrs - The raw attribute string of the tag.
 * @returns The element, or null when `bounds` is missing or malformed.
 */
export function parseNodeAttributes(attrs: string): UIElement | null {
  const get = (name: string): string | undefined => {
    const attrMatch = attrs.match(new RegExp(`${name}="([^"]*)"`, 'u'));
    return attrMatch?.[1] || undefined;
  };

  const boundsStr = get('bounds');
  if (!boundsStr) {
    return null;
  }

  // bounds format: [x1,y1][x2,y2]; any coordinate can be negative.
  const boundsMatch = boundsStr.match(
    /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/u,
  );
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
    frame: {
      x: x1,
      y: y1,
      width: Math.max(0, x2 - x1),
      height: Math.max(0, y2 - y1),
    },
    enabled: get('enabled') !== 'false',
  };
}
