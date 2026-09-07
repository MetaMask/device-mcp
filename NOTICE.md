# Third-party notices

## agent-device (Callstack) — MIT

Portions of the Android snapshot-helper host-side code are derived from the
`agent-device` project by Callstack.

- Upstream: https://github.com/callstackincubator/agent-device
- License: MIT — Copyright (c) 2026 Callstack
- Full license text: see the end of this file.

### What is derived

The structure and approach of the following host-side TypeScript modules were
adapted from `agent-device`:

- `src/backends/android-instrumentation/artifact.ts` — manifest parsing and
  artifact SHA-256 verification.
- `src/backends/android-instrumentation/errors.ts` — the `SnapshotHelperError`
  shape (the `UntrustedHelperError` trust class is our addition).
- `src/backends/android-instrumentation/adb.ts` — the device-scoped ADB
  executor abstraction.
- `src/backends/android-instrumentation/installer.ts` — the versionCode-based
  install policy and signer-verification install flow.

### What is NOT derived

The following are original to this project and are not taken from
`agent-device`:

- The instrumentation helper APK and its Java source
  (`android/snapshot-helper/`), including the `foregroundWindowObserved`
  capture fix. This project builds its own APK from source; it does not
  redistribute Callstack's prebuilt binary or use their package name.
- `src/backends/android-instrumentation/signer.ts` — a pure-JS APK Signature
  Scheme v2/v3 signature verifier implemented from the public AOSP
  specification.
- `src/backends/android-instrumentation/snapshot.ts` — the chunked
  instrumentation output parser.

### agent-device MIT license

```
MIT License

Copyright (c) 2026 Callstack

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
