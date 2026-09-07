package io.metamask.devicemcp.snapshothelper;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.os.Bundle;
import android.util.Base64;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeoutException;



/**
 * Instrumentation entry point that captures the Android accessibility
 * hierarchy without the stock {@code uiautomator dump} idle-wait tax.
 *
 * <p>Run via:
 *
 * <pre>
 * adb shell am instrument -w \
 *   -e waitForIdleTimeoutMs 0 \
 *   -e timeoutMs 8000 -e maxDepth 128 -e maxNodes 5000 \
 *   io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation
 * </pre>
 *
 * <p>The result XML is streamed back as base64 chunks in instrumentation
 * status records, then a final result record reports {@code ok}, counts, and
 * the parameters used.
 */
public final class SnapshotInstrumentation extends Instrumentation {

  // Bounded wait for microinteraction reliability without the stock idle tax.
  // Callers pass 0 to skip the idle wait entirely (immediate capture).
  private static final long DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 500;
  private static final long DEFAULT_WAIT_FOR_IDLE_QUIET_MS = 100;
  private static final long DEFAULT_TIMEOUT_MS = 8_000;
  private static final long ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS = 500;
  private static final int DEFAULT_MAX_DEPTH = 128;
  private static final int DEFAULT_MAX_NODES = 5_000;
  private static final int CHUNK_SIZE = 2 * 1024;
  private static final int STATUS_IN_PROGRESS = 2;

  private Bundle arguments;

  @Override
  public void onCreate(Bundle arguments) {
    super.onCreate(arguments);
    this.arguments = arguments == null ? new Bundle() : arguments;
    start();
  }

  @Override
  public void onStart() {
    super.onStart();
    Bundle result = new Bundle();
    long startedAtMs = System.currentTimeMillis();

    long waitForIdleTimeoutMs =
        parseLong("waitForIdleTimeoutMs", DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS);
    long waitForIdleQuietMs = parseLong("waitForIdleQuietMs", DEFAULT_WAIT_FOR_IDLE_QUIET_MS);
    long timeoutMs = parseLong("timeoutMs", DEFAULT_TIMEOUT_MS);
    int maxDepth = (int) parseLong("maxDepth", DEFAULT_MAX_DEPTH);
    int maxNodes = (int) parseLong("maxNodes", DEFAULT_MAX_NODES);
    // Optional: when set, the capture is only considered complete once a window
    // whose root reports this package has been appended. Left null to preserve
    // the package-agnostic default (capture whatever is foreground).
    String targetPackage = parseString("targetPackage");

    try {
      AccessibilityTreeCapture.Result capture =
          captureXml(
              waitForIdleQuietMs,
              waitForIdleTimeoutMs,
              timeoutMs,
              maxDepth,
              maxNodes,
              targetPackage);

      sendXmlChunks(capture.xml);

      result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
      result.putInt("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
      result.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
      result.putString("ok", "true");
      result.putString("waitForIdleTimeoutMs", Long.toString(waitForIdleTimeoutMs));
      result.putString("waitForIdleQuietMs", Long.toString(waitForIdleQuietMs));
      result.putString("timeoutMs", Long.toString(timeoutMs));
      result.putString("maxDepth", Integer.toString(maxDepth));
      result.putString("maxNodes", Integer.toString(maxNodes));
      result.putString("rootPresent", Boolean.toString(capture.rootPresent));
      result.putString("captureMode", capture.captureMode);
      result.putString("windowCount", Integer.toString(capture.windowCount));
      result.putString("nodeCount", Integer.toString(capture.nodeCount));
      result.putString("truncated", Boolean.toString(capture.truncated));
      result.putString(
          "foregroundWindowObserved",
          Boolean.toString(capture.foregroundWindowObserved));
      if (targetPackage != null) {
        result.putString("targetPackage", targetPackage);
        result.putString(
            "targetPackageMatched", Boolean.toString(capture.targetPackageMatched));
      }
      result.putString("elapsedMs", Long.toString(System.currentTimeMillis() - startedAtMs));
    } catch (Throwable error) {
      result.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
      result.putInt("helperApiVersion", HelperProtocol.HELPER_API_VERSION);
      result.putString("ok", "false");
      result.putString("errorType", error.getClass().getName());
      result.putString("message", String.valueOf(error.getMessage()));
      result.putString("elapsedMs", Long.toString(System.currentTimeMillis() - startedAtMs));
    }

    finishSafely(result);
  }

  @SuppressWarnings("deprecation")
  private AccessibilityTreeCapture.Result captureXml(
      long waitForIdleQuietMs,
      long waitForIdleTimeoutMs,
      long timeoutMs,
      int maxDepth,
      int maxNodes,
      String targetPackage)
      throws TimeoutException,
          InterruptedException,
          BoundedUiAutomationConnection.TimeoutException,
          AccessibilityCaptureStabilizer.IncompleteCaptureException {
    UiAutomation automation = getConnectedUiAutomation(timeoutMs);
    AccessibilityTreeCapture.enableInteractiveWindowRetrieval(automation);

    if (waitForIdleTimeoutMs > 0) {
      try {
        // Best-effort settle: require only a short quiet window once the stream
        // goes idle, but bound the total wait. Using the full timeout as the
        // quiet window would make every stable snapshot pay a fixed tax.
        long quietMs = Math.min(waitForIdleQuietMs, waitForIdleTimeoutMs);
        automation.waitForIdle(quietMs, waitForIdleTimeoutMs);
      } catch (TimeoutException ignored) {
        // Busy/animated apps still expose a usable root; capture what is available.
      }
    }

    return AccessibilityTreeCapture.capture(
        automation,
        maxDepth,
        maxNodes,
        ROOT_CAPTURE_STABILIZATION_TIMEOUT_MS,
        targetPackage);
  }

  private UiAutomation getConnectedUiAutomation(long timeoutMs)
      throws InterruptedException, BoundedUiAutomationConnection.TimeoutException {
    return BoundedUiAutomationConnection.await(this::tryGetConnectedUiAutomation, timeoutMs);
  }

  private UiAutomation tryGetConnectedUiAutomation() {
    UiAutomation automation = getUiAutomation();
    if (automation == null) {
      return null;
    }
    try {
      // Throws IllegalStateException with a "connecting"/"not connected"
      // message until the accessibility service is actually connected.
      automation.getServiceInfo();
      return automation;
    } catch (IllegalStateException error) {
      if (isUiAutomationConnectingError(error) || isUiAutomationNotConnectedError(error)) {
        return null;
      }
      throw error;
    }
  }

  private void sendXmlChunks(String xml) {
    byte[] bytes = xml.getBytes(StandardCharsets.UTF_8);
    int chunkCount = Math.max(1, (bytes.length + CHUNK_SIZE - 1) / CHUNK_SIZE);
    for (int chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      int offset = chunkIndex * CHUNK_SIZE;
      int length = Math.min(CHUNK_SIZE, bytes.length - offset);
      String payload =
          length <= 0 ? "" : Base64.encodeToString(bytes, offset, length, Base64.NO_WRAP);

      Bundle status = new Bundle();
      status.putString("agentDeviceProtocol", HelperProtocol.PROTOCOL);
      status.putString("outputFormat", HelperProtocol.OUTPUT_FORMAT);
      status.putInt("chunkIndex", chunkIndex);
      status.putInt("chunkCount", chunkCount);
      status.putString("payloadBase64", payload);
      sendStatus(STATUS_IN_PROGRESS, status);
    }
  }

  private void finishSafely(Bundle result) {
    // finish() can throw the same "connecting" IllegalStateException if an
    // in-flight UiAutomation connect never completed. Retry, then detach.
    for (int attempt = 0; attempt < 100; attempt += 1) {
      try {
        finish(android.app.Activity.RESULT_OK, result);
        return;
      } catch (IllegalStateException error) {
        if (!isUiAutomationConnectingError(error)) {
          throw error;
        }
        sleepQuietly(100);
      }
    }
    detachUiAutomation();
    finish(android.app.Activity.RESULT_OK, result);
  }

  private void detachUiAutomation() {
    try {
      Field field = Instrumentation.class.getDeclaredField("mUiAutomation");
      field.setAccessible(true);
      field.set(this, null);
    } catch (ReflectiveOperationException ignored) {
      // Nothing more we can do; the subsequent finish() may still throw.
    }
  }

  private long parseLong(String key, long defaultValue) {
    String raw = arguments.getString(key);
    if (raw == null) {
      return defaultValue;
    }
    try {
      return Long.parseLong(raw.trim());
    } catch (NumberFormatException error) {
      return defaultValue;
    }
  }

  private String parseString(String key) {
    String raw = arguments.getString(key);
    if (raw == null) {
      return null;
    }
    String trimmed = raw.trim();
    return trimmed.isEmpty() ? null : trimmed;
  }

  private static boolean isUiAutomationConnectingError(IllegalStateException error) {
    String message = error.getMessage();
    return message != null && message.contains("while connecting");
  }

  private static boolean isUiAutomationNotConnectedError(IllegalStateException error) {
    String message = error.getMessage();
    return message != null && message.contains("not connected");
  }

  private static void sleepQuietly(long millis) {
    try {
      Thread.sleep(millis);
    } catch (InterruptedException error) {
      Thread.currentThread().interrupt();
    }
  }
}
