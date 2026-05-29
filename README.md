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
- **iOS local**: Xcode Command Line Tools (for `xcrun simctl`) + [IDB](https://fbidb.io/) for UI interaction (`brew tap facebook/fb && brew install idb-companion && pip3 install fb-idb`)
- **Android local**: ADB (Android SDK platform-tools) — auto-discovered from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or `~/Library/Android/sdk`
- **Remote/BrowserStack**: No local tools needed — connects via Appium W3C WebDriver HTTP

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

### Element Identification

Elements are identified by accessibility attributes — not internal refs. Matching is **fuzzy**: partial text and case-insensitive matches work. For example, querying `{ label: "Confirm" }` matches an element with label `"Confirm Transaction"`.

- **iOS**: accessibility label, accessibility identifier
- **Android**: content-description, resource-id, text

### Backend Implementation

| Tool                      | iOS (IDB)                            | Android (ADB)        | Appium (W3C WebDriver)        |
| ------------------------- | ------------------------------------ | -------------------- | ----------------------------- |
| `device_snapshot`         | `idb ui describe-all`                | `uiautomator dump`   | `mobile: source`              |
| `device_screenshot`       | `idb screenshot`                     | `screencap` + `pull` | `mobile: getScreenshot`       |
| `device_info`             | `idb describe`                       | `getprop`            | session capabilities          |
| `device_tap_element`      | find + `idb ui tap`                  | find + `input tap`   | find + W3C Actions            |
| `device_tap_coordinates`  | `idb ui tap x y`                     | `input tap x y`      | W3C Actions                   |
| `device_type`             | `idb ui text`                        | `input text`         | `findElement` + `sendKeys`    |
| `device_swipe`            | `idb ui swipe`                       | `input swipe`        | W3C Actions                   |
| `device_long_press`       | `idb ui tap --duration`              | `input swipe` (hold) | W3C Actions (pause)           |
| `device_wait_for`         | poll snapshot                        | poll snapshot        | poll snapshot                 |
| `device_list_devices`     | `xcrun simctl list`                  | `adb devices`        | N/A                           |
| `device_select_device`    | select by UDID                       | select by serial     | N/A                           |
| `device_app_state`        | `idb list-apps` / `simctl listapps`  | `dumpsys activity`   | `mobile: queryAppState`       |
| `device_open_app`         | `idb launch` / `simctl launch`       | `monkey -p`          | `mobile: activateApp`         |
| `device_close_app`        | `idb terminate` / `simctl terminate` | `am force-stop`      | `mobile: terminateApp`        |
| `device_press_button`     | `idb ui key`                         | `input keyevent`     | `mobile: pressButton/Key`     |
| `device_dismiss_keyboard` | `idb ui key RETURN`                  | `input keyevent 111` | `mobile: hideKeyboard`        |
| `device_dismiss_alert`    | find button + tap                    | find button + tap    | `mobile: accept/dismissAlert` |
| `device_logs`             | `idb log`                            | `logcat`             | `mobile: getLog`              |

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
│   ├── server.ts               # MCP server — registers 25 tools
│   ├── backends/
│   │   ├── types.ts            # DeviceBackend interface
│   │   ├── idb-backend.ts      # iOS local — IDB commands + simctl fallback
│   │   ├── adb-backend.ts      # Android local — ADB commands + XML parser
│   │   ├── appium-backend.ts   # Remote — Appium/BrowserStack via W3C WebDriver
│   │   ├── webdriver-client.ts # Minimal W3C WebDriver HTTP client (fetch)
│   │   ├── session-file.ts     # .device-session file reader
│   │   └── index.ts            # createBackend() + createLazyBackend() factory
│   ├── tools/                  # One file per MCP tool (25 tools)
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
