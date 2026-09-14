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

# Build-tools selection. We PIN a known-good version because apksigner's
# `--print-certs` output format has changed across releases (37.0.0 relabels the
# signer line, which broke naive signer-SHA extraction). Pinning keeps the
# provenance parsing deterministic. Falls back to the newest available with a
# warning if the pinned version is not installed.
PINNED_BUILD_TOOLS_VERSION="36.0.0"
if [[ -d "$SDK/build-tools/$PINNED_BUILD_TOOLS_VERSION" ]]; then
  BUILD_TOOLS_DIR="$SDK/build-tools/$PINNED_BUILD_TOOLS_VERSION"
else
  BUILD_TOOLS_DIR="$(find "$SDK/build-tools" -maxdepth 1 -mindepth 1 -type d \
    | sort -V | tail -n 1)"
  echo "Warning: build-tools $PINNED_BUILD_TOOLS_VERSION not found; using $BUILD_TOOLS_DIR." >&2
fi
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
# Key resolution (D1/D5):
#   1. DEVICE_MCP_HELPER_KEYSTORE (+ _PASSWORD / _KEY_ALIAS) -> the real shared
#      key (CI secret decode, or a dev's vault copy). APKs signed with it match
#      the pinned signerSha256, so the on-device trust check accepts them.
#   2. Otherwise -> generate a throwaway per-build key. The resulting APK will
#      NOT match the pin; the helper path rejects it by design (use
#      DEVICE_MCP_ADB_SNAPSHOT=dump for local iteration without the real key).
if [[ -n "${DEVICE_MCP_HELPER_KEYSTORE:-}" ]]; then
  KEYSTORE="$DEVICE_MCP_HELPER_KEYSTORE"
  KS_PASS="${DEVICE_MCP_HELPER_KEYSTORE_PASSWORD:-}"
  KEY_ALIAS="${DEVICE_MCP_HELPER_KEY_ALIAS:-device-mcp-helper}"
  if [[ ! -f "$KEYSTORE" ]]; then
    echo "Error: DEVICE_MCP_HELPER_KEYSTORE set but not found: $KEYSTORE" >&2
    exit 1
  fi
  if [[ -z "$KS_PASS" ]]; then
    echo "Error: DEVICE_MCP_HELPER_KEYSTORE set but DEVICE_MCP_HELPER_KEYSTORE_PASSWORD is empty." >&2
    exit 1
  fi
  echo "  signing:     shared helper key ($KEY_ALIAS)"
  "$APKSIGNER" sign \
    --ks "$KEYSTORE" \
    --ks-pass "pass:$KS_PASS" \
    --key-pass "pass:$KS_PASS" \
    --ks-key-alias "$KEY_ALIAS" \
    --out "$FINAL_APK" \
    "$ALIGNED_APK"
else
  echo "  signing:     THROWAWAY per-build key (APK will NOT match the pinned signer)" >&2
  THROWAWAY_KS="$WORK_DIR/throwaway.keystore"
  keytool -genkeypair -v \
    -keystore "$THROWAWAY_KS" \
    -alias throwaway -keyalg RSA -keysize 2048 -validity 30 \
    -storepass throwaway -keypass throwaway \
    -dname "CN=Device MCP Helper Throwaway, OU=device-mcp, O=MetaMask, C=US" >/dev/null 2>&1
  "$APKSIGNER" sign \
    --ks "$THROWAWAY_KS" \
    --ks-pass pass:throwaway \
    --key-pass pass:throwaway \
    --ks-key-alias throwaway \
    --out "$FINAL_APK" \
    "$ALIGNED_APK"
fi

"$APKSIGNER" verify --min-sdk-version 23 "$FINAL_APK"

# --- 7. Provenance manifest ----------------------------------------------------
# Emit <apk>.manifest.json alongside the APK: the single source of truth for
# package/runner/versionCode + the apk sha256 (dist tamper check) + the
# apksigner-verified signer cert SHA-256 (the runtime trust pin).
APK_SHA256="$(openssl dgst -sha256 "$FINAL_APK" | awk '{print $NF}')"
# Extract the signer cert SHA-256 in a format-INDEPENDENT way: grab the 64-char
# hex run directly rather than relying on field positions. apksigner's
# `--print-certs` line label has changed across build-tools versions (e.g. 37.0.0
# prints `V3.0 Signer: certificate SHA-256 digest: <hex>` instead of
# `Signer #1 certificate SHA-256 digest: <hex>`); splitting on ': ' by field put
# the label text where the hex was expected and silently produced a corrupt pin.
# Collect all matching scheme lines (v2/v3/v3.1 carry the same cert) and dedupe.
SIGNER_SHA256="$("$APKSIGNER" verify --print-certs "$FINAL_APK" \
  | awk '/certificate SHA-256 digest:/ { if (match($0, /[0-9a-fA-F]{64}/)) print tolower(substr($0, RSTART, RLENGTH)) }' \
  | sort -u)"
# Must be exactly one well-formed 64-char hex digest. This guard fails the build
# loudly on any future parser regression, in every environment, instead of
# emitting a corrupt manifest pin that breaks the on-device trust check.
SIGNER_LINE_COUNT="$(printf '%s\n' "$SIGNER_SHA256" | grep -c .)"
if [[ "$SIGNER_LINE_COUNT" -ne 1 || ! "$SIGNER_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Error: could not extract a single valid signer SHA-256 from apksigner" >&2
  echo "       output (got: '${SIGNER_SHA256//$'\n'/, }')." >&2
  exit 1
fi
MANIFEST="$OUTPUT_DIR/device-mcp-android-snapshot-helper-$VERSION.manifest.json"
cat > "$MANIFEST" <<JSON
{
  "version": "$VERSION",
  "versionCode": $VERSION_CODE,
  "packageName": "io.metamask.devicemcp.snapshothelper",
  "instrumentationRunner": "io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation",
  "assetName": "device-mcp-android-snapshot-helper-$VERSION.apk",
  "sha256": "$APK_SHA256",
  "signerSha256": "$SIGNER_SHA256",
  "minSdk": 23
}
JSON

# Ship the third-party attribution alongside the APK it covers. The package's
# `files` field is constrained to `["dist"]`, and npm does not auto-include
# NOTICE.md, so copy it into dist/android so it is redistributed with the APK.
NOTICE_SRC="$HELPER_DIR/../../NOTICE.md"
if [[ -f "$NOTICE_SRC" ]]; then
  cp "$NOTICE_SRC" "$OUTPUT_DIR/NOTICE.md"
fi

echo "Built:    $FINAL_APK"
echo "Manifest: $MANIFEST"
echo "  apk sha256:    $APK_SHA256"
echo "  signer sha256: $SIGNER_SHA256"
