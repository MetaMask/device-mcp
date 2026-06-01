# @metamask/device-mcp — Agent Reference

You interact with a mobile device (iOS simulator, Android emulator, or BrowserStack remote device) through the `device-mcp` MCP server. It exposes 25 tools for device management, inspecting UI state, interacting with elements, capturing evidence, and controlling app lifecycle.

## When to Use This

- **Debugging a failing E2E test** — see what's actually on screen when a test fails
- **Exploring app state** — inspect the UI hierarchy without writing test code
- **Building new tests** — discover element identifiers, labels, and layout
- **Verifying UI changes** — check that a screen looks right after a code change
- **Self-healing test recovery** — find alternative paths when an element is missing

## Getting Started — Device Selection

When multiple devices are connected, the server won't auto-pick one. Use the device management tools first:

```
device_list_devices         # See all connected simulators/emulators/devices
device_select_device        # Pick the one you want to use
```

If only one device is connected, it's auto-selected. If `DEVICE_ID` is set, this step is skipped.

## Core Loop

```
device_snapshot             # 1. ALWAYS see what's on screen first
device_tap_element          # 2. Interact with an element
device_snapshot             # 3. See the result — NEVER assume screen state
```

**Critical rules:**

- **ALWAYS call `device_snapshot` before interacting.** You cannot guess what's on screen.
- **NEVER call `device_snapshot` twice without acting in between.** If the screen hasn't changed, the hierarchy won't either.
- **ALWAYS call `device_snapshot` after interacting.** Confirm the action had the expected effect.
- **Call `device_dismiss_keyboard` after typing.** The keyboard obscures elements below the input.
- **Call `device_dismiss_alert` when a system dialog appears.** Permission prompts block all other interaction.
- **Use `device_screenshot` for visual evidence.** Snapshots show accessibility data; screenshots show what the user sees.

## Tools

### device_list_devices (read-only)

List all connected devices and simulators/emulators. Returns platform and device ID for each.

**When:** Multiple devices are connected and you need to pick one. Checking what's available before starting.

**Output format:**

```
Platform	Device ID
ios	FACF3006-1FF8-482A-B6EF-58995E1DF1CB
android	emulator-5554
```

### device_select_device

Select a device to use for this session. Call `device_list_devices` first to see available devices.

```json
{ "deviceId": "FACF3006-1FF8-482A-B6EF-58995E1DF1CB" }
```

**When:** After `device_list_devices` shows multiple devices. The agent should present the list to the user and let them choose.

### device_snapshot (read-only)

Capture the full UI accessibility hierarchy. Returns every visible element with type, label, identifier, value, frame coordinates, and enabled state.

**When:** Before every interaction. After every interaction. When you need to understand the current screen.

**Output format:**

```
Platform: ios
Timestamp: 2025-01-15T10:30:00.000Z
Elements:
[Window] (0,0 390x844)
  [Button] label="Submit" id="submit-btn" (20,700 350x44)
  [TextField] label="Password" value="•••" id="password-input" (20,200 350x44)
  [StaticText] value="Welcome back" (20,100 350x30)
  [Button] label="Settings" (350,50 30x30) DISABLED
```

### device_tap_element

Find an element by query and tap its center. Specify at least one of: `label`, `identifier`, `text`, `type`.

**Targeting priority:**

1. `identifier` — most reliable (maps to testID / resource-id)
2. `label` — accessibility label / content-description
3. `text` — visible text content (matches both `value` and `label`)
4. `type` — element class (least specific, combine with other fields)

**Matching is fuzzy:** partial text and case-insensitive matches work. `{ label: "Confirm" }` matches `"Confirm Transaction"`.

**Examples:**

```json
{ "identifier": "submit-btn" }
{ "label": "Submit" }
{ "text": "Send", "type": "Button" }
```

### device_tap_coordinates

Tap at exact screen coordinates. Use as a **last resort** when element queries fail. Get coordinates from `device_snapshot` frame data.

```json
{ "x": 195, "y": 722 }
```

### device_long_press

Long press an element. Used for context menus, drag initiation, and other long-press interactions.

```json
{ "label": "Transaction", "durationMs": 2000 }
```

### device_type

Type text into the currently focused input. **Tap an input field first** to focus it, then call this.

```json
{ "text": "mypassword123" }
```

**Mobile-specific:** On Android, spaces are escaped automatically. After typing, the keyboard may obscure elements — swipe or tap elsewhere to dismiss it.

### device_swipe

Swipe on screen. Uses **natural scrolling**: swipe `"up"` to scroll content **down** (reveal content below).

```json
{ "direction": "up" }
{ "direction": "down", "startX": 200, "startY": 400, "distance": 300 }
```

**When:** Scroll to reveal off-screen elements. Dismiss bottom sheets. Navigate between pages.

### device_wait_for

Poll the hierarchy until an element appears. Use after navigation or when waiting for async content.

```json
{ "label": "Welcome", "timeoutMs": 15000 }
{ "identifier": "balance-display" }
```

**When:** After tapping a navigation element. Waiting for a loading screen to resolve. Waiting for a modal to appear.

### device_app_state (read-only)

Check if an app is running, installed, or absent.

```json
{ "bundleId": "io.metamask" }
```

### device_info (read-only)

Get device platform, name, OS version, and device ID.

**When:** Understanding which device/platform you're connected to. Including platform-specific instructions in your workflow.

### device_screenshot (read-only)

Capture a screenshot of the current screen. Returns base64 PNG image data.

```json
{ "outputPath": "./screenshots/debug.png" }
```

**When:** Collecting visual evidence. Verifying UI appearance. Debugging layout issues.

### device_open_app

Launch or bring an app to foreground.

```json
{ "bundleId": "io.metamask" }
```

### device_close_app

Force-stop an app.

```json
{ "bundleId": "io.metamask" }
```

### device_press_button

Press a physical device button.

```json
{ "button": "home" }
{ "button": "back" }
```

Note: iOS has no back button — `"back"` maps to home.

### device_dismiss_keyboard

Hide the on-screen keyboard. Call after typing to reveal elements that the keyboard may obscure.

### device_dismiss_alert

Accept or dismiss a system alert or permission dialog.

```json
{ "accept": true }
{ "accept": false }
```

**When:** Permission prompts (camera, notifications, location) appear. System dialogs block interaction.

### device_logs (read-only)

Capture recent device logs with optional text filter.

```json
{ "durationSeconds": 60, "filter": "MetaMask" }
```

**When:** Investigating crashes, errors, or unexpected behavior. Collecting debugging evidence.

## Element Identification — Platform Differences

| Attribute      | iOS                                                 | Android                                    |
| -------------- | --------------------------------------------------- | ------------------------------------------ |
| `identifier`   | `accessibilityIdentifier`                           | `resource-id` (format: `package:id/name`)  |
| `label`        | `accessibilityLabel` (may differ from visible text) | `content-description`                      |
| `text`/`value` | `accessibilityValue` or visible text                | `text` attribute                           |
| `type`         | Accessibility type (e.g., `Button`, `TextField`)    | View class (e.g., `android.widget.Button`) |

## Common Patterns

### Select a device when multiple are connected

```
device_list_devices                                     # see all devices
# present list to user, get their choice
device_select_device { "deviceId": "FACF3006-..." }     # select device
device_snapshot                                          # start working
```

### Navigate to a screen and verify

```
device_snapshot                                          # see current state
device_tap_element { "identifier": "settings-tab" }     # tap settings tab
device_wait_for { "label": "Settings" }                 # wait for screen
device_snapshot                                          # verify we're there
```

### Fill a form

```
device_snapshot                                          # see available inputs
device_tap_element { "identifier": "email-input" }      # focus the field
device_type { "text": "user@example.com" }              # type into it
device_dismiss_keyboard                                  # hide keyboard
device_tap_element { "identifier": "password-input" }   # focus next field
device_type { "text": "secret123" }                     # type password
device_dismiss_keyboard                                  # hide keyboard
device_tap_element { "identifier": "submit-btn" }       # submit
device_snapshot                                          # verify result
```

### Scroll to find an element

```
device_snapshot                                          # element not visible
device_swipe { "direction": "up" }                      # scroll down
device_snapshot                                          # check again
# repeat until element is found, then interact
```

### Handle a system dialog

```
device_snapshot                                          # see dialog
device_dismiss_alert { "accept": true }                  # accept permission
device_snapshot                                          # verify dismissed
```

### Launch app, debug, collect evidence

```
device_open_app { "bundleId": "io.metamask" }            # launch app
device_snapshot                                          # see initial screen
device_screenshot { "outputPath": "./debug/home.png" }   # visual evidence
device_logs { "filter": "MetaMask", "durationSeconds": 60 } # check for errors
device_close_app { "bundleId": "io.metamask" }           # stop app
```

### Navigate with device buttons

```
device_press_button { "button": "home" }                 # go to home screen
device_press_button { "button": "back" }                 # go back (Android)
```

## Error Handling

All tools return `isError: true` on failure with a descriptive message. Common errors:

| Error                 | Cause                                   | Recovery                                                                                                                            |
| --------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Element not found     | Query doesn't match any visible element | Call `device_snapshot` to see what's actually there. The element may have a different label/id, be off-screen, or not yet rendered. |
| Timed out waiting     | Element didn't appear within timeout    | Increase `timeoutMs`, or the expected element may not appear on this screen. Call `device_snapshot` to see current state.           |
| idb/adb not installed | Tool dependency missing                 | Follow the install instructions in the error message.                                                                               |
| Device not ready      | Simulator/emulator not booted           | Boot a simulator or start an emulator before running.                                                                               |

## BrowserStack / Remote Devices

When a `.device-session` file exists in the working directory, the MCP server connects via Appium instead of local IDB/ADB. This works for BrowserStack, Sauce Labs, or any Appium server.

**Behavior differences on remote devices:**

- `device_snapshot` uses the Appium page source API instead of IDB/ADB CLI tools
- On iOS, the server limits hierarchy depth (`snapshotMaxDepth: 30`) to avoid stack overflow on complex apps, and uses `mobile: source` as a lighter alternative to `getPageSource`
- `device_tap_element` and `device_swipe` use W3C Actions API (touch pointer sequences)
- Expect longer response times — add generous `timeoutMs` values to `device_wait_for` calls

**Element identification is the same across all backends** — use `identifier`, `label`, `text`, `type`.

## Setup

### Local (simulator/emulator)

Ensure a simulator/emulator is booted:

```bash
# iOS — boot a simulator
xcrun simctl boot "iPhone 16"

# Android — start an emulator
emulator -avd Pixel_7_API_34
```

iOS simulators are discovered via `xcrun simctl` (ships with Xcode). ADB is auto-discovered from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, or `~/Library/Android/sdk`. IDB is auto-discovered from `$PATH`, `/usr/local/bin`, `/opt/homebrew/bin`, or `~/Library/Python/*/bin`.

No `PATH` configuration is needed in the MCP client — tools are found automatically.

### Remote (BrowserStack/Appium)

Create a `.device-session` file — see the README for the full schema. The test runner typically writes this when starting the Appium session.

### MCP Client Configuration

```json
{
  "mcpServers": {
    "device": {
      "command": "npx",
      "args": ["@metamask/device-mcp"]
    }
  }
}
```
