# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Fixed

- fix: GH workflow release creation
- chore: add additional tools
- chore: add MetaMask Security Code Scanner workflow

### Added

- Initial release of `@metamask/device-mcp`
- MCP server with stdio transport and lazy backend initialization
- Three backends: iOS (IDB), Android (ADB), Appium/BrowserStack (W3C WebDriver)
- `.device-session` file for attaching to existing Appium sessions or creating new ones
- 16 MCP tools: `device_snapshot`, `device_screenshot`, `device_info`, `device_tap_element`, `device_tap_coordinates`, `device_type`, `device_swipe`, `device_long_press`, `device_wait_for`, `device_app_state`, `device_open_app`, `device_close_app`, `device_press_button`, `device_dismiss_keyboard`, `device_dismiss_alert`, `device_logs`
- Fuzzy element matching (case-insensitive, partial text)
- Android tree-structured UI hierarchy parser (nested, not flat)
- iOS `snapshotMaxDepth` and `mobile: source` fallback for deep hierarchies
- Auto-detection of platform from `.device-session`, `DEVICE_ID`, or booted simulator/emulator
- Runtime health check with actionable error messages for missing IDB/ADB
- SKILL.md agent reference with core loop, common patterns, and platform differences
- MetaMask module template compliance (ts-bridge, dual CJS/ESM, yarn constraints, CI workflows)

[Unreleased]: https://github.com/MetaMask/device-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MetaMask/device-mcp/releases/tag/v0.1.0
