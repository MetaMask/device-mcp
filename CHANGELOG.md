# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `TargetObscuredError` (`code: 'TARGET_OBSCURED'`, with `obscuredBy`, `keyboard` and the tap point) ([#51](https://github.com/MetaMask/device-mcp/pull/51))
- `ScrollToElementError` (`ELEMENT_NOT_FOUND` / `ELEMENT_NOT_IN_VIEWPORT`, with `swipes` and the last `frame`) and the `ScrollDirection` / `ScrollToElementResult` types ([#50](https://github.com/MetaMask/device-mcp/pull/50))
- `tapElement(query, { element })` taps an element the caller already resolved (for example from `waitForElement`) without taking a second snapshot

### Changed

- fix: taps fail instead of landing on another element ([#51](https://github.com/MetaMask/device-mcp/pull/51))
  - iOS `tapElement` / `longPress` hit-test the tap point first (`idb ui describe-point --api axbridge`, about 0.25 s). When another element is there (the keyboard or its AutoFill bar, a sheet, an overlay), they throw `TargetObscuredError` and do not tap. When the hit-test finds nothing, or idb cannot select the accessibility API, the tap goes ahead.
  - Android `tapElement` / `longPress` tap the visible part of the frame and refuse an element outside the screen (including rows clipped to zero height), like iOS. The screen size is read once per backend.
- **BREAKING:** fix: `scrollToElement` succeeds only when the element is in the viewport ([#50](https://github.com/MetaMask/device-mcp/pull/50))
  - It returns `{ element, swipes, inViewport: true }` instead of the element. Before, it returned as soon as the element was in the UI tree; React Native keeps off-screen rows in the tree, so it often returned after zero swipes with the element below the fold.
  - After a swipe it reads the screen until it stops moving. It fails with `ScrollToElementError` after `maxAttempts` swipes, or when the screen stops changing.
  - New default `direction: 'auto'`: the finger direction comes from the element's position (searching toward content below first while it is not in the tree). Explicit `up` / `down` stay finger directions. Before, the default `down` revealed content above.
  - Android and Appium swipe from the middle of the real screen (40% of its height), not from fixed coordinates.
- **BREAKING:** fix: iOS key presses, `back` and text clearing ([#48](https://github.com/MetaMask/device-mcp/pull/48))
  - iOS `pressButton('enter')` and `dismissKeyboard()` send the integer HID key code (`idb ui key 40`); `home` and `lock` use `idb ui button`. Both failed before because `idb ui key` takes only integer codes.
  - iOS `pressButton('back')` now throws `UNSUPPORTED_ON_IOS` instead of pressing Home (which put the app in the background).
  - iOS `dismissKeyboard()` does nothing when no keyboard is shown.
  - iOS `typeText` clears the field with Command+A and Backspace through strict execution. Before, the clear failed silently and the text was appended to the old value.
- iOS (idb): read `idb describe --json` once per companion connection for the OS version and window size, instead of before every snapshot, tap and swipe. `getDeviceInfo()` still reads it fresh

## [0.7.0]

### Added

- feat: add android clipboard helper ([#42](https://github.com/MetaMask/device-mcp/pull/42))
- feat: add session-scoped IDB companion teardown ([#43](https://github.com/MetaMask/device-mcp/pull/43))

### Changed

- fix: correct IDB recovery error reporting and resend safety ([#44](https://github.com/MetaMask/device-mcp/pull/44))

## [0.6.0]

### Added

- feat: faster, correct Android snapshots on busy screens ([#39](https://github.com/MetaMask/device-mcp/pull/39))
- feat: read idb describe-all nested format ([#38](https://github.com/MetaMask/device-mcp/pull/38))

## [0.5.0]

### Fixed

- fix: send Origin header for Hermes CDP connections ([#35](https://github.com/MetaMask/device-mcp/pull/35))

## [0.4.2]

### Added

- feat: add android webview cdp ([#31](https://github.com/MetaMask/device-mcp/pull/31))

## [0.4.1]

### Fixed

- fix: emit valid signerSha256 in helper manifest across apksigner vers… ([#29](https://github.com/MetaMask/device-mcp/pull/29))

## [0.4.0]

### Fixed

- fix: make idb gestures scroll and report correct device geometry ([#27](https://github.com/MetaMask/device-mcp/pull/27))
- fix: make simulator element extraction work across iOS 17-26 ([#25](https://github.com/MetaMask/device-mcp/pull/25))
- fix: code scanner error for java files ([#26](https://github.com/MetaMask/device-mcp/pull/26))
- fix: UI automator staleness issue ([#23](https://github.com/MetaMask/device-mcp/pull/23))

## [0.3.3]

### Changed

- feat: add public `kind` discriminator to DeviceBackend ([#21](https://github.com/MetaMask/device-mcp/pull/21))

## [0.3.2]

### Changed

- fix: enable simulator accessibility bridge for idb snapshots ([#19](https://github.com/MetaMask/device-mcp/pull/19))

## [0.3.1]

### Changed

- Export generateLocators/formatLocators ([#17](https://github.com/MetaMask/device-mcp/pull/17))

## [0.3.0]

### Added

- Add Hermes CDP tools (`hermes_cdp`, `hermes_targets`) for inspecting the React Native Hermes JS runtime via Metro ([#14](https://github.com/MetaMask/device-mcp/pull/14))

### Changed

- Make screenshot base64 encoding optional — `DeviceBackend.screenshot(outputPath, { encode })` accepts `{ encode: false }` to return only the file `path` and skip base64 encoding. `ScreenshotResult.data` is now optional; the default (`encode: true`) preserves existing behavior ([#15](https://github.com/MetaMask/device-mcp/pull/15))
- The Appium backend now saves the screenshot to `outputPath` when one is provided (previously the argument was ignored) ([#15](https://github.com/MetaMask/device-mcp/pull/15))

### Fixed

- Fix `device_screenshot` failing on macOS — the captured PNG is now read in-process via `fs.readFile(path, 'base64')` instead of shelling out to the `base64` CLI, which is not portable (BSD `base64` on macOS rejects the GNU positional-file syntax that was used previously) ([#15](https://github.com/MetaMask/device-mcp/pull/15))

### Security

- Harden screenshot and screen-recording file writes across the ADB, IDB, and Appium backends — default captures now use a private per-process temporary directory (`0700`) with unpredictable names instead of the predictable `/tmp/device-mcp-*-<timestamp>` paths, files are written owner-only (`0600`), and a symlink at the destination is never followed. Caller-supplied output paths can be confined to a single directory via the new `DEVICE_MCP_OUTPUT_DIR` environment variable

## [0.2.0]

### Added

- Add get element text and mapping to all backends ([#9](https://github.com/MetaMask/device-mcp/pull/9))
- Add device selection tools ([#7](https://github.com/MetaMask/device-mcp/pull/7))

## [0.1.0]

### Added

- Initial release of `@metamask/device-mcp`
- MCP server with stdio transport and lazy backend initialization
- Three backends: iOS (IDB), Android (ADB), Appium/BrowserStack (W3C WebDriver)
- `.device-session` file for attaching to existing Appium sessions or creating new ones
- 16 MCP tools: `device_snapshot`, `device_screenshot`, `device_info`, `device_tap_element`, `device_tap_coordinates`, `device_type`, `device_swipe`, `device_long_press`, `device_wait_for`, `device_app_state`, `device_open_app`, `device_close_app`, `device_press_button`, `device_dismiss_keyboard`, `device_dismiss_alert`, `device_logs`

[Unreleased]: https://github.com/MetaMask/device-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/MetaMask/device-mcp/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/MetaMask/device-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/MetaMask/device-mcp/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/MetaMask/device-mcp/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/MetaMask/device-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/MetaMask/device-mcp/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/MetaMask/device-mcp/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/MetaMask/device-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/MetaMask/device-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MetaMask/device-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MetaMask/device-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MetaMask/device-mcp/releases/tag/v0.1.0
