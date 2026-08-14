#!/usr/bin/env bash

set -e
set -o pipefail

if [[ -n $SKIP_PREPACK ]]; then
  echo "Notice: skipping prepack."
  exit 0
fi

yarn build

# Fail packaging before a stale or corrupt vendored APK can be shipped.
(
  cd src/backends/android-snapshot-helper/vendor
  shasum -a 256 -c agent-device-android-snapshot-helper-0.14.9.apk.sha256
)

# ts-bridge only emits compiled .ts; copy the vendored Android snapshot-helper
# APK, checksum, manifest, and license/notice so they ship in the npm tarball.
mkdir -p dist/backends/android-snapshot-helper/vendor
cp src/backends/android-snapshot-helper/vendor/* \
  dist/backends/android-snapshot-helper/vendor/

chmod +x dist/cli/device-mcp.mjs
