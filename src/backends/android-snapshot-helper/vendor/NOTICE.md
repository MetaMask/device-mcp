# Vendored Android snapshot helper

The host-side TypeScript in this directory's parent (`../*.ts`) and the prebuilt
Android instrumentation APK in this folder are derived from / redistributed from
the `agent-device` project by Callstack.

- Upstream: https://github.com/callstackincubator/agent-device
- Version / tag: `v0.14.9`
- Commit: `336bf17af44e9be1810592d5dc42163771c3e8de`
- License: MIT — Copyright (c) 2026 Callstack (see `LICENSE.MIT` in this folder)

## What is vendored

1. **Prebuilt instrumentation APK** (redistributed verbatim):
   - `agent-device-android-snapshot-helper-0.14.9.apk`
   - `agent-device-android-snapshot-helper-0.14.9.apk.sha256`
   - `agent-device-android-snapshot-helper-0.14.9.manifest.json`

   Android package: `com.callstack.agentdevice.snapshothelper`
   Instrumentation runner: `com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation`

2. **Host-side capture / install / parse logic** (adapted, in `../capture.ts`,
   `../install.ts`, `../artifact.ts`, `../types.ts`, `../errors.ts`).

## Why the APK is redistributed as-is

The upstream helper APK is signed with a committed debug keystore and its package
id is Callstack's. For now this repository redistributes that prebuilt artifact
unchanged so the feature is fully functional. A follow-up should re-package the
instrumentation under a MetaMask-owned Android package name and a MetaMask-owned
signing identity to avoid install/signing collisions with `agent-device`. See the
project decision note for details.

## Attribution requirement

Per the MIT license, the copyright and permission notice (`LICENSE.MIT`) is
preserved in this repository and in the published npm tarball.
