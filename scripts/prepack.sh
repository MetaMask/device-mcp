#!/usr/bin/env bash

set -e
set -o pipefail

if [[ -n $SKIP_PREPACK ]]; then
  echo "Notice: skipping prepack."
  exit 0
fi

yarn build

chmod +x dist/cli/device-mcp.mjs

# Build the Android snapshot-helper instrumentation APK into dist/android so it
# ships with the package (files: ["dist"]). The ADB backend installs it on
# demand to capture the UI hierarchy on screens where `uiautomator dump` never
# reaches idle. Requires the Android SDK; set SKIP_ANDROID_HELPER=1 to opt out
# (the instrument snapshot path is then unavailable and the backend falls back
# to `uiautomator dump`).
if [[ -n $SKIP_ANDROID_HELPER ]]; then
  echo "Notice: skipping Android snapshot-helper APK build."
else
  VERSION="$(node -p "require('./package.json').version")"
  ./scripts/build-android-helper.sh "$VERSION" dist/android
fi
