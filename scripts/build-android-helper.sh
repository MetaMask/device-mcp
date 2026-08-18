#!/usr/bin/env bash
#
# Builds the Android snapshot-helper instrumentation APK without Gradle, using
# only the Android SDK command-line build tools (javac -> d8 -> aapt2 link ->
# zip dex in -> zipalign -> apksigner).
#
# Usage:
#   scripts/build-android-helper.sh <version> <outputDir>
#
# Requires ANDROID_HOME or ANDROID_SDK_ROOT pointing at an SDK with a
# platforms/android-36 platform and matching build-tools, plus a JDK (javac).

set -euo pipefail

if [[ ${RUNNER_DEBUG:-0} == 1 ]]; then
  set -x
fi

VERSION="${1:-}"
OUTPUT_DIR="${2:-}"

if [[ -z "$VERSION" ]]; then
  echo "Error: version not specified (arg 1)." >&2
  exit 1
fi
if [[ -z "$OUTPUT_DIR" ]]; then
  echo "Error: output directory not specified (arg 2)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$SCRIPT_DIR/../android/snapshot-helper"
HELPER_DIR="$(cd "$HELPER_DIR" && pwd)"

# --- Resolve the Android SDK ---------------------------------------------------
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
if [[ ! -d "$SDK" ]]; then
  echo "Error: Android SDK not found at '$SDK'. Set ANDROID_HOME." >&2
  exit 1
fi

PLATFORM_DIR="$SDK/platforms/android-36"
ANDROID_JAR="$PLATFORM_DIR/android.jar"
if [[ ! -f "$ANDROID_JAR" ]]; then
  echo "Error: android.jar not found at '$ANDROID_JAR' (need platform android-36)." >&2
  exit 1
fi

# Newest build-tools directory (version-sorted).
BUILD_TOOLS_DIR="$(find "$SDK/build-tools" -maxdepth 1 -mindepth 1 -type d \
  | sort -V | tail -n 1)"
if [[ -z "$BUILD_TOOLS_DIR" ]]; then
  echo "Error: no build-tools found under '$SDK/build-tools'." >&2
  exit 1
fi

D8="$BUILD_TOOLS_DIR/d8"
AAPT2="$BUILD_TOOLS_DIR/aapt2"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"
for tool in "$D8" "$AAPT2" "$ZIPALIGN" "$APKSIGNER"; do
  if [[ ! -f "$tool" ]]; then
    echo "Error: required build tool missing: $tool" >&2
    exit 1
  fi
done

# --- Version code from semver (major*1e6 + minor*1e3 + patch) -------------------
VERSION_CODE="$(echo "$VERSION" | awk -F. '{ printf "%d", ($1*1000000)+($2*1000)+$3 }')"
if [[ -z "$VERSION_CODE" || "$VERSION_CODE" == "0" ]]; then
  VERSION_CODE=1
fi

# --- Working directories -------------------------------------------------------
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

CLASSES_DIR="$WORK_DIR/classes"
DEX_DIR="$WORK_DIR/dex"
mkdir -p "$CLASSES_DIR" "$DEX_DIR"

UNSIGNED_APK="$WORK_DIR/helper-unsigned.apk"
ALIGNED_APK="$WORK_DIR/helper-aligned.apk"
FINAL_APK="$OUTPUT_DIR/device-mcp-android-snapshot-helper-$VERSION.apk"

echo "Building snapshot helper $VERSION (versionCode $VERSION_CODE)"
echo "  SDK:         $SDK"
echo "  build-tools: $BUILD_TOOLS_DIR"

# --- 1. Compile Java -> .class -------------------------------------------------
JAVA_SOURCES="$(find "$HELPER_DIR/src/main/java" -name '*.java')"
javac --release 11 -classpath "$ANDROID_JAR" -d "$CLASSES_DIR" $JAVA_SOURCES

# --- 2. Dex --------------------------------------------------------------------
CLASS_FILES="$(find "$CLASSES_DIR" -name '*.class')"
"$D8" --min-api 23 --classpath "$ANDROID_JAR" --output "$DEX_DIR" $CLASS_FILES

# --- 3. Link manifest into an APK shell ---------------------------------------
"$AAPT2" link \
  --manifest "$HELPER_DIR/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  --min-sdk-version 23 \
  --target-sdk-version 36 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION" \
  -o "$UNSIGNED_APK"

# --- 4. Inject the dex into the APK -------------------------------------------
(cd "$DEX_DIR" && zip -q -j "$UNSIGNED_APK" "$DEX_DIR/classes.dex")

# --- 5. Align ------------------------------------------------------------------
"$ZIPALIGN" -f 4 "$UNSIGNED_APK" "$ALIGNED_APK"

# --- 6. Sign -------------------------------------------------------------------
"$APKSIGNER" sign \
  --ks "$HELPER_DIR/debug.keystore" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$FINAL_APK" \
  "$ALIGNED_APK"

"$APKSIGNER" verify --min-sdk-version 23 "$FINAL_APK"

echo "Built: $FINAL_APK"
