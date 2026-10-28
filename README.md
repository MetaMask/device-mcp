# @metamask/device-mcp

MCP server for mobile device interaction — iOS (simctl + IDB), Android (ADB), and remote devices (Appium/BrowserStack).

Provides device interaction tools for LLM agents to inspect UI state, interact with elements, capture evidence, and control app lifecycle. Works standalone for debugging or as part of the [self-healing test infrastructure](https://github.com/MetaMask/metamask-mobile) for MetaMask Mobile.

## Use Cases

- **Debugging locally** — attach to a running simulator/emulator from your AI coding agent, inspect what's on screen, tap elements, check logs
- **Debugging Appium tests** — attach to a live Appium session while a test is running to see what the test sees
- **Self-healing tests** — the healer agent uses these tools to recover from test failures by finding alternative UI paths
- **Exploratory testing** — let an agent navigate the app, exercise flows, and collect evidence
- **Building E2E tests** — discover element identifiers, labels, and layout to write test assertions

## Requirements

- **Node.js** `^20 || ^22 || >=24`
- **iOS local**: Xcode Command Line Tools (for `xcrun simctl`) + [IDB](https://fbidb.io/) for UI interaction. Install the unified client (`brew tap facebook/fb && brew install idb`), which bundles the CLI and simulator companion. On iOS 17+ simulators, element extraction requires this modern `idb` (it uses `idb ui describe-all --api axbridge`); the legacy python `fb-idb` client does not support `--api` and will not read the UI hierarchy on newer runtimes.
- **Android local**: ADB (Android SDK platform-tools) — auto-discovered from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or `~/Library/Android/sdk`
- **Remote/BrowserStack**: No local tools needed — connects via Appium W3C WebDriver HTTP
- **Hermes CDP** (debugging the React Native JS runtime): uses the global `WebSocket` API. Node 22+ works out of the box; **Node 20 requires launching with `NODE_OPTIONS="--experimental-websocket"`**.

## Installation

```bash
yarn add @metamask/device-mcp
```

Or run directly:

```bash
npx @metamask/device-mcp
```

## Usage

The server communicates over stdio using the [Model Context Protocol](https://modelcontextprotocol.io/). It starts immediately and defers device connection to the first tool call — so the MCP handshake completes even when no device is available yet.

```bash
# Auto-detect connected device
device-mcp

# Target a specific device
DEVICE_ID=<udid-or-serial> device-mcp

# Target a specific platform (useful in CI with one device per platform)
DEVICE_PLATFORM=ios device-mcp
DEVICE_PLATFORM=android device-mcp
```

### Backend Selection

The server selects a backend in this order:

1. **`.device-session` file** — if present in the working directory, connects via Appium (local or BrowserStack)
2. **`DEVICE_ID` + `DEVICE_PLATFORM`** — direct connect, no auto-detection
3. **`DEVICE_ID` only** — platform inferred from format (UUID = iOS, serial/emulator-\* = Android)
4. **`DEVICE_PLATFORM` only** — auto-detect first device of that platform
5. **Nothing set, 1 device** — auto-connect
6. **Nothing set, multiple devices** — returns device list, agent asks user to pick via `device_select_device`

### Multi-Device Selection

When multiple devices are connected and no `DEVICE_ID` is set, the server enters an "awaiting selection" state. Any tool call returns the list of available devices. Use `device_list_devices` to enumerate them and `device_select_device` to choose one.

### Connection lifecycle

IDB backends start a private `idb_companion` child with a unique Unix socket and route their commands through `IDB_COMPANION`. They do not register, reuse, or disconnect the global UDID connection. This isolates teardown across simulators and across backend instances targeting the same simulator.

Programmatic callers should release their backend after use:

```typescript
const backend = await createBackend(deviceId, 'ios');
try {
  await backend.snapshot();
} finally {
  await backend.dispose?.();
}
```

`dispose()` is idempotent and stops only that backend's companion and active recording, then removes its socket directory. It does not close apps or shut down simulators. Existing shared companions and other sessions remain running. Other backends can omit this optional lifecycle hook. The stdio server disposes its backend on transport close, SIGINT, and SIGTERM; an uncatchable process kill cannot run disposal.

`await lazyBackend.selectDevice(deviceId)` releases the previous backend before switching. Device selection now returns a promise; callers must await it. Disposing an unused lazy backend does not connect to a device.

### Device Discovery

- **iOS simulators** are discovered via `xcrun simctl list devices booted --json` — no IDB needed for discovery
- **Android devices** are discovered via `adb devices` — the server probes `$ANDROID_HOME/platform-tools/adb`, `$ANDROID_SDK_ROOT/platform-tools/adb`, and `~/Library/Android/sdk/platform-tools/adb` when `adb` is not on `$PATH`
- **IDB** is resolved from `$PATH`, `/usr/local/bin`, `/opt/homebrew/bin`, and `~/Library/Python/*/bin` (pip user installs)

### BrowserStack / Appium

For remote devices or cloud testing, create a `.device-session` file in the working directory.

**Attach to an existing Appium session (local):**

```json
{
  "appiumUrl": "http://localhost:4723",
  "sessionId": "abc123-def456",
  "platform": "ios"
}
```

**Attach to a BrowserStack session:**

```json
{
  "appiumUrl": "https://hub-cloud.browserstack.com/wd/hub",
  "sessionId": "abc123-def456",
  "platform": "android",
  "auth": {
    "user": "YOUR_USERNAME",
    "key": "YOUR_ACCESS_KEY"
  }
}
```

**Create a new BrowserStack session:**

```json
{
  "appiumUrl": "https://hub-cloud.browserstack.com/wd/hub",
  "platform": "ios",
  "capabilities": {
    "platformName": "iOS",
    "appium:deviceName": "iPhone 15",
    "appium:app": "bs://app-hash",
    "bstack:options": { "userName": "...", "accessKey": "..." }
  },
  "auth": {
    "user": "YOUR_USERNAME",
    "key": "YOUR_ACCESS_KEY"
  }
}
```

The `.device-session` file is typically written by the test runner when it creates an Appium session, and read by the MCP server when healing or agent interaction is needed.

## Tools

### Device Management

| Tool                   | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `device_list_devices`  | List all connected devices and simulators/emulators.               |
| `device_select_device` | Select a device for this session. Use after `device_list_devices`. |

### Inspection

| Tool                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `device_snapshot`   | Capture the UI accessibility hierarchy. Call before interacting. |
| `device_screenshot` | Capture a screenshot as base64 PNG. Optionally save to file.     |
| `device_info`       | Get device platform, name, OS version, and device ID.            |
| `device_app_state`  | Check if an app is running, installed, or absent.                |
| `device_logs`       | Capture recent device logs (syslog/logcat) with optional filter. |

### Interaction

| Tool                     | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `device_tap_element`     | Find an element by label/identifier/text/type and tap its center.  |
| `device_tap_coordinates` | Tap at exact screen coordinates. Last resort when queries fail.    |
| `device_type`            | Type text into the currently focused input field.                  |
| `device_swipe`           | Swipe in a direction with optional start coordinates and distance. |
| `device_long_press`      | Long press an element for context menus or drag initiation.        |
| `device_wait_for`        | Poll until an element matching a query appears.                    |
| `device_press_button`    | Press a device button (home/back/enter/lock).                      |

### App & Device Control

| Tool                      | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `device_open_app`         | Launch or foreground an app by bundle ID.              |
| `device_close_app`        | Force-stop an app by bundle ID.                        |
| `device_dismiss_keyboard` | Hide the on-screen keyboard after typing.              |
| `device_dismiss_alert`    | Accept or dismiss a system alert or permission dialog. |

### CDP (Hermes & WebView)

| Tool             | Description                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `hermes_cdp`     | Speak raw Chrome DevTools Protocol to the React Native Hermes JS runtime (no DOM).              |
| `hermes_targets` | List and diagnose the debuggable Hermes targets exposed by Metro.                               |
| `webview_cdp`    | Speak raw CDP to a debuggable in-app **Android WebView** — the DOM of the app's in-app browser. |

### Element Identification

Elements are identified by accessibility attributes — not internal refs. Matching is **fuzzy**: partial text and case-insensitive matches work. For example, querying `{ label: "Confirm" }` matches an element with label `"Confirm Transaction"`.

- **iOS**: accessibility label, accessibility identifier
- **Android**: content-description, resource-id, text

### Backend Implementation

| Tool                      | iOS (IDB)                            | Android (ADB)                               | Appium (W3C WebDriver)        |
| ------------------------- | ------------------------------------ | ------------------------------------------- | ----------------------------- |
| `device_snapshot`         | `idb ui describe-all`                | `uiautomator dump` + instrumentation helper | `mobile: source`              |
| `device_screenshot`       | `idb screenshot`                     | `screencap` + `pull`                        | `mobile: getScreenshot`       |
| `device_info`             | `idb describe`                       | `getprop`                                   | session capabilities          |
| `device_tap_element`      | find + `idb ui tap`                  | find + `input tap`                          | find + W3C Actions            |
| `device_tap_coordinates`  | `idb ui tap x y`                     | `input tap x y`                             | W3C Actions                   |
| `device_type`             | `idb ui text`                        | `input text`                                | `findElement` + `sendKeys`    |
| `device_swipe`            | `idb ui swipe`                       | `input swipe`                               | W3C Actions                   |
| `device_long_press`       | `idb ui tap --duration`              | `input swipe` (hold)                        | W3C Actions (pause)           |
| `device_wait_for`         | poll snapshot                        | poll snapshot                               | poll snapshot                 |
| `device_list_devices`     | `xcrun simctl list`                  | `adb devices`                               | N/A                           |
| `device_select_device`    | select by UDID                       | select by serial                            | N/A                           |
| `device_app_state`        | `idb list-apps` / `simctl listapps`  | `dumpsys activity`                          | `mobile: queryAppState`       |
| `device_open_app`         | `idb launch` / `simctl launch`       | `monkey -p`                                 | `mobile: activateApp`         |
| `device_close_app`        | `idb terminate` / `simctl terminate` | `am force-stop`                             | `mobile: terminateApp`        |
| `device_press_button`     | `idb ui key`                         | `input keyevent`                            | `mobile: pressButton/Key`     |
| `device_dismiss_keyboard` | `idb ui key RETURN`                  | `input keyevent 111`                        | `mobile: hideKeyboard`        |
| `device_dismiss_alert`    | find button + tap                    | find button + tap                           | `mobile: accept/dismissAlert` |
| `device_logs`             | `idb log`                            | `logcat`                                    | `mobile: getLog`              |

#### Android snapshot on continuously-redrawing screens

`uiautomator dump` calls `UiAutomation.waitForIdle` internally, which never
returns on a screen that emits a continuous accessibility-event stream (for
example a React Native screen with polling or an animating skeleton loader). On
those screens the stock dump fails with `ERROR: could not get idle state.`

To handle this, the ADB backend ships a small self-instrumenting helper APK
(`dist/android/device-mcp-android-snapshot-helper-*.apk`, built during
`prepack`). The helper captures the accessibility hierarchy **without** waiting
for idle: it skips `waitForIdle` and instead retries a cheap capture until the
foreground window's root is present, then streams the hierarchy back over
`am instrument` as chunked base64. It is installed on demand the first time it
is needed and reused across snapshots in the session.

Snapshot modes:

| Mode           | Order                                                                 | Dump fallback                        |
| -------------- | --------------------------------------------------------------------- | ------------------------------------ |
| `helper-first` | Helper, then 1 `uiautomator dump` attempt (3 if the helper never ran) | Non-trust helper failures only       |
| `auto`         | 1 quick dump, then the helper, then up to 3 dump attempts             | Non-trust helper failures only       |
| `instrument`   | Helper only                                                           | None (fully fail-closed)             |
| `dump`         | Up to 3 `uiautomator dump` attempts (the original behavior)           | Not applicable (no APK is installed) |

- **Default:** `helper-first` when the bundled helper APK is available, else
  `dump` (for example a local build without the APK, or an APK that fails its
  manifest digest check). When it falls back to `dump`, the backend prints the
  reason once to stderr. The helper does not wait for idle, so it is fast on
  busy screens. It also returns a fuller tree than the dump, for example
  WebView content that the dump leaves out.
- **First snapshot:** the first helper snapshot of a backend may also install
  the helper. The install has its own timeout (up to 60 s) and runs outside the
  25 s snapshot deadline, so that first snapshot can take longer. Later
  snapshots reuse the install. If the helper is uninstalled mid-session, the
  next snapshot reinstalls it once and checks its signer again before it runs.
- **`auto`** is sticky per backend instance. When the quick dump fails and the
  helper then succeeds, later snapshots skip the quick dump: on a busy screen it
  waits about 11 s for an idle state before it fails. When the helper later
  fails and the dump fallback succeeds, the next snapshot tries the quick dump
  first again. Note that on an idle screen `auto` returns the dump tree, which
  can be smaller than the helper tree.
- **Incomplete captures:** the helper waits at most 500 ms for the foreground
  window's root. During a screen transition the root can be missing for
  longer, and the helper reports `Capture did not stabilize within 500ms`. In
  every mode that uses the helper, the backend then runs the helper up to 2
  more times, 250 ms apart, within the 25 s snapshot deadline, before any dump
  fallback.
- **`helper-first` dump cap:** when the helper ran on the device and still
  failed, the screen is probably busy, and each `uiautomator dump` attempt
  there waits about 11 s for an idle state before it fails. So `helper-first`
  makes only 1 dump attempt in that case, and fails fast if it does not work.
  It keeps 3 dump attempts when the helper never ran (for example the install
  failed).
- A trust failure (see below) never falls back to dump in any mode, and is
  never retried.

> **TODO (next helper release):** the 500 ms root-stabilization timeout is
> hard-coded in the APK (`ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS` in
> `SnapshotInstrumentation.java`). Make it an instrumentation argument, like
> `timeoutMs`, so the backend can pass a longer value. The shipped APK ignores
> unknown arguments, so the backend retries instead for now.

Select a mode with the `adb.snapshotMode` option of `createBackend` /
`createLazyBackend`, or with the `DEVICE_MCP_ADB_SNAPSHOT` environment
variable. The option takes precedence over the environment variable. An unknown
`snapshotMode` throws; an unknown environment value is ignored (the default
applies):

```ts
import { createBackend, createLazyBackend } from '@metamask/device-mcp';

const backend = await createBackend('emulator-5554', 'android', {
  adb: { snapshotMode: 'instrument' },
});

const lazy = createLazyBackend('emulator-5554', 'android', {
  adb: { snapshotMode: 'instrument' },
});
```

The `device-mcp` MCP server CLI passes no option, so it uses
`DEVICE_MCP_ADB_SNAPSHOT` or the default. Its default changes too: it was
`auto` and is now `helper-first`. To keep the old behavior, set
`DEVICE_MCP_ADB_SNAPSHOT=auto` in the server's environment.

On the ADB backend, each `SnapshotResult` also reports `source` (`'dump'` or
`'instrument'`, the path that produced the tree) and `captureMs` (the capture
time, including failed attempts and fallbacks).

The helper is a `testOnly` APK installed with `adb install -t`, so it only
installs on developer emulators/attached devices, never on locked-down or
managed profiles.

##### Trust: the helper's signing certificate is verified before use

Package names and version codes are attacker-controlled metadata, so before the
backend runs `am instrument` it verifies that the installed helper is actually
**ours**. It pulls the installed APK(s) and cryptographically verifies their APK
Signature Scheme v2/v3 signature (a pure-JS check — no Android SDK required at
runtime), then compares the signer certificate SHA-256 against the value pinned
in the bundled build manifest. If a different app is squatting the helper's
package name, the signer will not match: the snapshot **fails closed** with a
trust error and does **not** silently fall back to `uiautomator dump`. Generic,
non-trust failures (a churny screen, an `am` hiccup) still fall back to dump in
`helper-first` and `auto` mode. Use `instrument` for a fully fail-closed mode,
or `dump` to skip the helper entirely.

If installation fails, the backend checks the package that remains on the
device. A different signer or a failed trust check stops the snapshot, regardless
of the install error text. A verified signer or confirmed absence preserves the
install error and permits dump fallback in `helper-first` and `auto` mode.

The check runs before **every** `am instrument`. It is never cached as a
"trusted" flag, because anyone who can install packages could replace a
trusted helper with a same-package squatter between two snapshots. To keep it
cheap, each backend instance does this:

1. It runs `pm path` on every snapshot to get the installed APK path(s).
2. It pulls and verifies the APK(s) again only when the paths are different
   from the last successful verification (or the pinned signer changed). A
   failed check is never remembered, so the next snapshot verifies in full.

This is safe because, on Android 8.0 (API 26) and later, every install or
update of a package goes to a new randomized directory under `/data/app/`
(`/data/app/~~<random>/<package>-<random>/` from Android 11). So a replaced
helper always has a new path. Replacing the APK bytes at the same path needs
root, and root is outside this threat model: a root user can also tamper with
the helper process, `am`, or `adbd` directly. Before API 26 a package path can
repeat across installs, so the backend pulls and verifies on every snapshot
there, as it does when it cannot read the API level. On the measured emulator
the full check took about 87 ms per snapshot (p50); `pm path` alone is one
`adb shell` round trip.

If a helper signed by a different key is already on the device (for example a
release helper, and your local build is signed with a throwaway key), the
install is refused and every helper snapshot fails closed. The trust error
names the fix: uninstall it with
`adb uninstall io.metamask.devicemcp.snapshothelper` so the bundled helper can
be installed, or use the `dump` mode.

##### Building the Android snapshot helper locally

The helper APK is normally built for you by `prepack` and (for releases) in CI.
You only need this if you are developing the helper or want the helper-based
snapshot path to work against a local build.

Requirements: JDK 17, Android SDK with `platforms/android-36` and
`build-tools;36.0.0` (auto-discovered from `$ANDROID_HOME` / `$ANDROID_SDK_ROOT`
/ `~/Library/Android/sdk`).

The helper is signed with a shared key, so your local build and the released
helper can replace each other on a device without a signer conflict. Obtain
the keystore from the team vault, place it **outside** the repo, point the
build at it, and build:

```bash
export DEVICE_MCP_HELPER_KEYSTORE=~/.device-mcp/helper.keystore
export DEVICE_MCP_HELPER_KEYSTORE_PASSWORD=<from vault>
export DEVICE_MCP_HELPER_KEY_ALIAS=device-mcp-helper
yarn build:android-helper
```

The APK and its `.manifest.json` land in `dist/android/`. The MCP server
installs the APK on demand and verifies its signing certificate before use.

**Don't have the keystore?** The build script auto-generates a throwaway key
when `DEVICE_MCP_HELPER_KEYSTORE` is unset. The pinned signer comes from the
manifest of the APK you just built, so a fresh throwaway-signed helper installs
and verifies normally. It fails only when a helper signed with a different key
is already installed on the device (for example from a release build or an
earlier throwaway build): Android refuses the install, and the snapshot fails
closed with a trust error. Then run
`adb uninstall io.metamask.devicemcp.snapshothelper`, or use
`DEVICE_MCP_ADB_SNAPSHOT=dump`.

> Never commit a keystore. `*.keystore`, `*.jks`, `*.p12`, and `~/.device-mcp/`
> are gitignored.

##### Maintainers: one-time signing key generation

```bash
keytool -genkeypair -v -keystore device-mcp-helper.keystore \
  -alias device-mcp-helper -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Device MCP Snapshot Helper, OU=device-mcp, O=MetaMask, C=US"
```

Store the keystore in the team vault for developers. For CI, add repository
secrets `ANDROID_HELPER_KEYSTORE_B64` (`base64 -i device-mcp-helper.keystore`),
`ANDROID_HELPER_KEYSTORE_PASSWORD`, and `ANDROID_HELPER_KEY_ALIAS`. Then pin the
certificate SHA-256 that the build emits (`signerSha256` in the manifest) as the
runtime trust anchor.

## Hermes CDP

Beyond native UI automation (idb/adb), the server can speak [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (CDP) directly to the **React Native Hermes** JS runtime of a running app via Metro's inspector proxy. This lets an agent evaluate JavaScript, inspect runtime state, and diagnose the app's JS layer — complementing the native tools. Works on **both iOS and Android** (the transport is identical HTTP/WebSocket to Metro; only the default `appId` differs).

This is _React Native Hermes CDP via Metro's inspector proxy_ — the app's Hermes runtime connects out to Metro; Metro exposes debuggable targets over `http://localhost:<metroPort>/json` and a per-target `webSocketDebuggerUrl`, and the server speaks real CDP over that WebSocket. It targets the **React Native JS engine** (no DOM). To drive the DOM of a web page inside an in-app WebView, use the separate [`webview_cdp`](#webview-cdp-android) tool instead — and note this is not the iOS WebKit Inspector Protocol.

### Prerequisites

- A **DEBUG build with Metro running** on the inspector port. Release builds expose no inspector (`/json` returns `[]`).
- The global `WebSocket` API: **Node 22+ works out of the box**; **Node 20 requires launching with `NODE_OPTIONS="--experimental-websocket"`** (see [Requirements](#requirements)).

### Tools

| Tool             | Description                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| `hermes_cdp`     | Speak raw Chrome DevTools Protocol to the React Native Hermes JS runtime. |
| `hermes_targets` | List and diagnose the debuggable Hermes targets exposed by Metro.         |

Example `hermes_cdp` call: method `Runtime.evaluate` with params `{"expression":"1+1","returnByValue":true}` — the raw response nests the value at `result.result.value`.

### Safety model

A single Metro can have multiple apps/simulators registered, so executing CDP against the wrong target could run code in the wrong workspace. The server applies five fail-closed checks before executing:

1. **Strict `appId` match** — only targets whose `appId` equals the expected id (no substring, no `targets[0]` fallback).
2. **`HermesInternal` identity probe** — evaluates `HermesInternal.getRuntimeProperties()` before the user's method; non-Hermes targets fail closed.
3. **Device pin** — pins `reactNative.logicalDeviceId` on first success; later calls are filtered to the pin.
4. **Multi-device fail-closed** — multiple distinct logical devices (or any missing the field) fail closed rather than guess.
5. **WebSocket URL validation** — protocol must be `ws:`, hostname must be loopback, and port must equal the resolved Metro port.

The synthetic legacy page (`React Native Experimental (Improved Chrome Reloads)`) is filtered out, and destructive methods `Runtime.terminateExecution` and `Inspector.detached` are blocked.

### Configuration

- **appId** defaults to `io.metamask.MetaMask` (iOS) / `io.metamask` (Android). Override globally via the `HERMES_APP_ID` env var or per-call via the tool's `appId` param. Android users not on the default must pass `appId` or set `HERMES_APP_ID`; `hermes_targets` with `all: true` aids discovery of the real appId.
- **Metro port** defaults to `8081`. Override via the `HERMES_METRO_PORT` env var or per-call via the tool's `metroPort` param.
- **Debugger Origin** defaults to `http://127.0.0.1:<metroPort>`, including when the target URL uses `localhost` or IPv6 loopback. This satisfies React Native 0.85+ and Expo SDK 57's debugger Origin checks. For a custom Metro server base URL (for example, Expo started with `REACT_NATIVE_PACKAGER_HOSTNAME=localhost`), set `HERMES_CDP_ORIGIN=http://localhost:8081` in the device-mcp process or pass the tool's `origin` param. The per-call value takes precedence. Use an HTTP(S) origin without credentials, path, query, or fragment; an explicitly empty value is invalid. Unset `HERMES_CDP_ORIGIN` to use the default. This header override does not change the local connection address or URL validation.

## WebView CDP (Android)

Separately from Hermes, the server can speak CDP to a **debuggable in-app Android `WebView`** — the Chromium web page inside an app's in-app browser. Where `hermes_cdp` reaches the React Native JS engine (no DOM), `webview_cdp` reaches the page's DOM and exposes the full Chrome surface: `Runtime`, `DOM`, `Page`, `Network`, `Input`.

Use it to click buttons, fill inputs, or read values on a web page rendered inside the app. For the app's **native** UI (e.g. a MetaMask signature confirmation sheet), use the native `device_*` tools — a typical dapp flow alternates between the two.

### Prerequisites

- **Android only.** The app must have called `WebView.setWebContentsDebuggingEnabled(true)` (debug builds usually do). The socket appears as `webview_devtools_remote_<pid>`.
- The global `WebSocket` API: **Node 22+ works out of the box**; **Node 20 requires `NODE_OPTIONS="--experimental-websocket"`**.

### Tool

| Tool          | Description                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------- |
| `webview_cdp` | Speak raw CDP to a debuggable in-app Android WebView — the DOM of the app's in-app browser. |

Example: method `Runtime.evaluate` with params `{"expression":"document.querySelector('#submit').click()","returnByValue":true}`. Pass `urlFilter` to select a specific page when several WebViews are open.

### How it works

The server enumerates the WebView's abstract debug socket from `/proc/net/unix`, forwards it to an ephemeral local TCP port with `adb forward`, discovers the page target via `http://localhost:<port>/json/list`, speaks CDP over the page's `webSocketDebuggerUrl`, and **removes the forward automatically** after the call. When a debuggable WebView is open, `device_context` also lists a `WEBVIEW` context.

### Safety model

- **Loopback-only WebSocket** — protocol must be `ws:`, hostname must be loopback, port must equal the forwarded local port.
- **Blocked destructive methods** — `Browser.close`, `Target.closeTarget`, `Target.disposeBrowserContext`, `Browser.crashGpuProcess`.
- **Socket disambiguation** — when multiple WebView sockets exist, the app's PID selects the right one; a genuinely ambiguous match fails closed rather than guessing.

## File Output & Safety

`device_screenshot` and `device_screen_recording` write image/video files to disk. These artifacts can contain sensitive on-screen content (seed phrases, private keys, balances), so writes are hardened:

- **No `outputPath`** — the file is written into a private, per-process temporary directory (`0700`) with an unpredictable name, rather than a predictable `/tmp/device-mcp-*-<timestamp>` path (which is exposed to symlink and information-disclosure attacks on shared hosts).
- **With `outputPath`** — the path is resolved to an absolute path and written owner-only (`0600`); a symlink already present at the destination is never followed.
- **`DEVICE_MCP_OUTPUT_DIR`** — set this to confine every caller-supplied `outputPath` to a single directory. Any path resolving outside it is rejected. Leave it unset to allow writing to any path the server process can access.

## MCP Client Configuration

### opencode

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "device": {
      "type": "local",
      "command": ["npx", "-y", "@metamask/device-mcp"]
    }
  }
}
```

IDB and ADB are auto-discovered from standard install locations. No `PATH` override needed unless tools are installed in custom directories.

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "device": {
      "command": "npx",
      "args": ["-y", "@metamask/device-mcp"]
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` in your project root:

```json
{
  "mcpServers": {
    "device": {
      "command": "npx",
      "args": ["-y", "@metamask/device-mcp"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "device": {
      "command": "npx",
      "args": ["-y", "@metamask/device-mcp"],
      "env": {
        "DEVICE_ID": "<optional-device-id>"
      }
    }
  }
}
```

## Architecture

```
@metamask/device-mcp
├── src/
│   ├── index.ts                # Entry point — lazy backend, stdio MCP server
│   ├── server.ts               # MCP server — registers 29 tools
│   ├── backends/
│   │   ├── types.ts            # DeviceBackend interface
│   │   ├── idb-backend.ts      # iOS local — IDB commands + simctl fallback
│   │   ├── adb-backend.ts      # Android local — ADB commands + XML parser
│   │   ├── appium-backend.ts   # Remote — Appium/BrowserStack via W3C WebDriver
│   │   ├── webdriver-client.ts # Minimal W3C WebDriver HTTP client (fetch)
│   │   ├── session-file.ts     # .device-session file reader
│   │   └── index.ts            # createBackend() + createLazyBackend() factory
│   ├── tools/                  # One file per MCP tool (28 tools)
│   │   ├── list-devices.ts     # device_list_devices — enumerate connected devices
│   │   ├── select-device.ts    # device_select_device — choose device for session
│   │   └── ...                 # snapshot, tap, type, swipe, etc.
│   └── utils/
│       ├── exec.ts             # Shell execution wrapper
│       ├── platform.ts         # Device discovery (simctl, adb), path resolution
│       └── element.ts          # Element search, matching, formatting
```

## Development

```bash
yarn build        # Compile TypeScript
yarn test         # Run tests
yarn lint         # Lint everything (ESLint + Prettier + changelog)
yarn lint:fix     # Auto-fix lint issues
yarn dev          # Watch mode compilation
```

## License

(MIT OR Apache-2.0)
