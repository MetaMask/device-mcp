# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0]

### Uncategorized

- feat: make screenshot base64 encoding optional ([#15](https://github.com/MetaMask/device-mcp/pull/15))
- feat: add Hermes CDP tools for React Native runtime access ([#14](https://github.com/MetaMask/device-mcp/pull/14))

### Added

- Add Hermes CDP tools (`hermes_cdp`, `hermes_targets`) for inspecting the React Native Hermes JS runtime via Metro

### Changed

- Make screenshot base64 encoding optional — `DeviceBackend.screenshot(outputPath, { encode })` accepts `{ encode: false }` to return only the file `path` and skip base64 encoding. `ScreenshotResult.data` is now optional; the default (`encode: true`) preserves existing behavior
- The Appium backend now saves the screenshot to `outputPath` when one is provided (previously the argument was ignored)

### Fixed

- Fix `device_screenshot` failing on macOS — the captured PNG is now read in-process via `fs.readFile(path, 'base64')` instead of shelling out to the `base64` CLI, which is not portable (BSD `base64` on macOS rejects the GNU positional-file syntax that was used previously)

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

[Unreleased]: https://github.com/MetaMask/device-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/MetaMask/device-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MetaMask/device-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MetaMask/device-mcp/releases/tag/v0.1.0
