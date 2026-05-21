# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Added

- Initial release of `@metamask/device-mcp`
- MCP server with stdio transport for mobile device interaction
- iOS backend via IDB (`idb ui describe-all`, `idb ui tap`, `idb ui text`, `idb ui swipe`)
- Android backend via ADB (`uiautomator dump`, `input tap`, `input text`, `input swipe`)
- Auto-detection of platform from connected device or `DEVICE_ID` env var
- 6 tools: `device_snapshot`, `device_tap_element`, `device_type`, `device_swipe`, `device_wait_for`, `device_app_state`
- Runtime health check with actionable error messages for missing IDB/ADB

[Unreleased]: https://github.com/MetaMask/device-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MetaMask/device-mcp/releases/tag/v0.1.0
