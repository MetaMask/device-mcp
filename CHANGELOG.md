# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0]

### Uncategorized

- fix: add permissions for publish job ([#12](https://github.com/MetaMask/device-mcp/pull/12))
- Revert "0.2.0" ([#11](https://github.com/MetaMask/device-mcp/pull/11))
- 0.2.0 ([#10](https://github.com/MetaMask/device-mcp/pull/10))
- test: add get element text and mapping to all backends ([#9](https://github.com/MetaMask/device-mcp/pull/9))
- chore: add device selection tools ([#7](https://github.com/MetaMask/device-mcp/pull/7))

## [0.1.0]

### Added

- Initial release of `@metamask/device-mcp`
- MCP server with stdio transport and lazy backend initialization
- Three backends: iOS (IDB), Android (ADB), Appium/BrowserStack (W3C WebDriver)
- `.device-session` file for attaching to existing Appium sessions or creating new ones
- 16 MCP tools: `device_snapshot`, `device_screenshot`, `device_info`, `device_tap_element`, `device_tap_coordinates`, `device_type`, `device_swipe`, `device_long_press`, `device_wait_for`, `device_app_state`, `device_open_app`, `device_close_app`, `device_press_button`, `device_dismiss_keyboard`, `device_dismiss_alert`, `device_logs`

[Unreleased]: https://github.com/MetaMask/device-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MetaMask/device-mcp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MetaMask/device-mcp/releases/tag/v0.1.0
