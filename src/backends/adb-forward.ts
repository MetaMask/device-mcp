/**
 * Pure helpers for reaching an Android `WebView`'s Chromium remote-debugging
 * endpoint over ADB, without Appium or chromedriver.
 *
 * A debuggable WebView publishes an abstract unix domain socket named
 * `webview_devtools_remote_<pid>` (older builds: `webview_devtools_remote`).
 * These helpers enumerate those sockets from `/proc/net/unix`, resolve the PIDs
 * that belong to a given app package, and manage the `adb forward` lifecycle
 * that maps the socket to a local TCP port.
 *
 * Every function takes an injected `adb` runner (a function that runs
 * `adb -s <serial> <args>` and resolves stdout) so the logic is unit-testable
 * without a device.
 */

/**
 * Runs an `adb` invocation for a single device and resolves its stdout.
 */
export type AdbRunner = (args: string[]) => Promise<string>;

/**
 * A discovered WebView devtools socket and the renderer PID encoded in its name
 * (undefined for the legacy unsuffixed `webview_devtools_remote` socket).
 */
export type WebViewSocket = {
  /** The abstract socket name, without the leading NUL/`@`. */
  name: string;
  /** The PID parsed from the socket suffix, when present. */
  pid?: number;
};

const SOCKET_NAME_PATTERN = /webview_devtools_remote(?:_(\d+))?$/u;

/**
 * Parses the names of all WebView devtools sockets from `/proc/net/unix`.
 *
 * The kernel lists abstract sockets with a leading `@`; the raw `/proc` dump
 * uses a leading NUL that `adb shell cat` renders as `@`. We match either.
 *
 * @param procNetUnix - The raw contents of `/proc/net/unix`.
 * @returns The discovered WebView sockets in file order.
 */
export function parseWebViewSockets(procNetUnix: string): WebViewSocket[] {
  const sockets: WebViewSocket[] = [];
  for (const line of procNetUnix.split('\n')) {
    const token = line.trim().split(/\s+/u).pop();
    if (!token) {
      continue;
    }
    // Abstract-socket names appear prefixed with `@` (display form) or a NUL
    // byte (raw form); strip either leading marker without a control-char regex.
    const firstChar = token.charCodeAt(0);
    const name =
      firstChar === 0x40 || firstChar === 0x00 ? token.slice(1) : token;
    const match = name.match(SOCKET_NAME_PATTERN);
    if (!match) {
      continue;
    }
    const pid =
      match[1] === undefined ? undefined : Number.parseInt(match[1], 10);
    sockets.push(pid === undefined ? { name } : { name, pid });
  }
  return sockets;
}

/**
 * Lists the WebView devtools sockets currently published on the device.
 *
 * @param adb - The device-scoped adb runner.
 * @returns The discovered sockets.
 */
export async function listWebViewSockets(
  adb: AdbRunner,
): Promise<WebViewSocket[]> {
  const raw = await adb(['shell', 'cat', '/proc/net/unix']);
  return parseWebViewSockets(raw);
}

/**
 * Resolves the set of PIDs that belong to an app package (the app process and
 * any of its child processes such as the sandboxed WebView renderer).
 *
 * @param adb - The device-scoped adb runner.
 * @param packageName - The app package to match (e.g. `io.metamask`).
 * @returns The matching PIDs.
 */
export async function resolvePackagePids(
  adb: AdbRunner,
  packageName: string,
): Promise<number[]> {
  const raw = await adb(['shell', 'pidof', packageName]).catch(() => '');
  const pids = raw
    .trim()
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value));
  return pids;
}

/**
 * Chooses the WebView devtools socket to debug.
 *
 * When exactly one socket exists it is used directly. When several exist, the
 * app's own PIDs disambiguate: WebView's renderer runs in a child process, so a
 * socket whose suffix PID is NOT one of the app PIDs is still selected only when
 * it is the sole candidate. Preference order:
 *   1. a socket whose suffix PID is one of the app PIDs;
 *   2. otherwise the single socket when there is exactly one;
 *   3. otherwise ambiguous failure.
 *
 * @param sockets - The discovered WebView sockets.
 * @param appPids - The PIDs belonging to the target app (may be empty).
 * @returns The chosen socket name, or a classified failure.
 */
export function selectWebViewSocket(
  sockets: WebViewSocket[],
  appPids: number[],
):
  | { ok: true; name: string; warning?: string }
  | { ok: false; reason: 'none' | 'ambiguous'; message: string } {
  if (sockets.length === 0) {
    return {
      ok: false,
      reason: 'none',
      message:
        'No webview_devtools_remote socket found. The app must call ' +
        'WebView.setWebContentsDebuggingEnabled(true) and have a WebView open.',
    };
  }

  const owned = sockets.filter(
    (socket) => socket.pid !== undefined && appPids.includes(socket.pid),
  );
  if (owned.length === 1) {
    return { ok: true, name: owned[0].name };
  }
  if (owned.length === 0 && sockets.length === 1) {
    const sole = sockets[0];
    // pidof did not tie this socket to the target app (the WebView renderer
    // runs in a child process that `pidof <package>` often does not list). We
    // still use the only socket, but surface the mismatch so a caller can audit
    // that it belongs to the intended app rather than a different one.
    if (appPids.length > 0) {
      return {
        ok: true,
        name: sole.name,
        warning:
          `Using the only WebView socket (${sole.name}) but it is not owned by ` +
          `the target app PIDs (${appPids.join(', ')}). Pass a urlFilter to ` +
          `confirm the page belongs to the intended app.`,
      };
    }
    return { ok: true, name: sole.name };
  }

  const candidates = (owned.length > 0 ? owned : sockets)
    .map((socket) => socket.name)
    .join(', ');
  return {
    ok: false,
    reason: 'ambiguous',
    message: `Multiple WebView devtools sockets are open (${candidates}). Pass a urlFilter to disambiguate the page, or close extra WebViews.`,
  };
}

/**
 * Forwards a device abstract socket to a local TCP port.
 *
 * @param adb - The device-scoped adb runner.
 * @param localPort - The local TCP port to bind.
 * @param socketName - The device abstract socket name (without `@`).
 */
export async function forwardWebViewSocket(
  adb: AdbRunner,
  localPort: number,
  socketName: string,
): Promise<void> {
  await adb(['forward', `tcp:${localPort}`, `localabstract:${socketName}`]);
}

/**
 * Removes a previously created local TCP forward. Never throws.
 *
 * @param adb - The device-scoped adb runner.
 * @param localPort - The local TCP port to release.
 */
export async function removeWebViewForward(
  adb: AdbRunner,
  localPort: number,
): Promise<void> {
  await adb(['forward', '--remove', `tcp:${localPort}`]).catch(() => undefined);
}
