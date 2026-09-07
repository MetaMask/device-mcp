package io.metamask.devicemcp.snapshothelper;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.List;

/**
 * Captures the accessibility hierarchy from a {@link UiAutomation} connection.
 *
 * <p>Prefers {@link UiAutomation#getWindows()} (all interactive windows:
 * keyboard, dialogs, overlays) and falls back to
 * {@link UiAutomation#getRootInActiveWindow()} when no window roots are
 * available. The whole capture is wrapped in a retry loop that reattempts
 * until roots are present, rather than waiting for accessibility idle.
 */
final class AccessibilityTreeCapture {

  /** Result of a single capture, carrying the XML plus completeness signals. */
  static final class Result implements AccessibilityCaptureStabilizer.Capture {
    final String xml;
    final boolean rootPresent;
    final boolean foregroundWindowRootsPresent;
    final String captureMode;
    final int windowCount;
    final int nodeCount;
    final boolean truncated;
    final boolean foregroundWindowObserved;
    final boolean targetPackageMatched;
    final boolean targetPackageRequired;

    Result(
        String xml,
        boolean rootPresent,
        boolean foregroundWindowRootsPresent,
        String captureMode,
        int windowCount,
        int nodeCount,
        boolean truncated,
        boolean foregroundWindowObserved,
        boolean targetPackageMatched,
        boolean targetPackageRequired) {
      this.xml = xml;
      this.rootPresent = rootPresent;
      this.foregroundWindowRootsPresent = foregroundWindowRootsPresent;
      this.captureMode = captureMode;
      this.windowCount = windowCount;
      this.nodeCount = nodeCount;
      this.truncated = truncated;
      this.foregroundWindowObserved = foregroundWindowObserved;
      this.targetPackageMatched = targetPackageMatched;
      this.targetPackageRequired = targetPackageRequired;
    }

    @Override
    public boolean isComplete() {
      // rootPresent + foregroundWindowRootsPresent were insufficient: a capture
      // containing only the status bar (neither active nor focused) tripped no
      // error flag and was wrongly accepted. foregroundWindowObserved is a
      // POSITIVE requirement that an actual foreground window root was appended,
      // which rejects the status-bar-only race without reintroducing
      // waitForIdle. The target-package gate is additive and only applies when a
      // target was requested.
      return rootPresent
          && foregroundWindowRootsPresent
          && foregroundWindowObserved
          && (!targetPackageRequired || targetPackageMatched);
    }
  }

  private AccessibilityTreeCapture() {}

  static Result capture(
      UiAutomation automation,
      int maxDepth,
      int maxNodes,
      long stabilizationTimeoutMs,
      String targetPackage)
      throws InterruptedException, AccessibilityCaptureStabilizer.IncompleteCaptureException {
    clearAccessibilityCache(automation);
    return AccessibilityCaptureStabilizer.capture(
        () -> captureOnce(automation, maxDepth, maxNodes, targetPackage),
        stabilizationTimeoutMs);
  }

  private static Result captureOnce(
      UiAutomation automation, int maxDepth, int maxNodes, String targetPackage) {
    AccessibilityTreeXml.Stats stats = new AccessibilityTreeXml.Stats();
    StringBuilder xml = new StringBuilder();
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
    xml.append("<hierarchy rotation=\"0\">");

    int windowCount =
        appendInteractiveWindowRoots(
            xml, automation, maxDepth, maxNodes, stats, targetPackage);
    String captureMode = "interactive-windows";

    if (AccessibilityCaptureStabilizer.requiresActiveWindowFallback(
        windowCount, stats.activeWindowRootMissing)) {
      boolean hasInteractiveWindowRoot = windowCount > 0;
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      try {
        AccessibilityTreeXml.WindowMetadata fallbackMetadata =
            stats.activeWindowMetadata == null
                ? null
                : stats.activeWindowMetadata.withIndex(windowCount);
        if (root != null
            && AccessibilityCaptureStabilizer.canAppendActiveWindowFallback(
                windowCount, fallbackMetadata != null)) {
          AccessibilityTreeXml.appendNode(
              xml, root, windowCount, 0, maxDepth, maxNodes, stats, fallbackMetadata);
          windowCount += 1;
          stats.activeWindowRootMissing = false;
          // The active-window fallback proves a foreground window exists even
          // when getWindows() was momentarily racing.
          stats.foregroundWindowObserved = true;
          if (targetPackage != null && matchesPackage(root, targetPackage)) {
            stats.targetPackageMatched = true;
          }
        }
        if (!hasInteractiveWindowRoot) {
          captureMode = "active-window";
        }
      } finally {
        if (root != null) {
          root.recycle();
        }
      }
    }

    xml.append("</hierarchy>");
    return new Result(
        xml.toString(),
        windowCount > 0,
        !stats.activeWindowRootMissing && !stats.focusedNonActiveWindowRootMissing,
        captureMode,
        windowCount,
        stats.nodeCount,
        stats.truncated,
        stats.foregroundWindowObserved,
        stats.targetPackageMatched,
        targetPackage != null);
  }

  @SuppressWarnings("deprecation")
  private static int appendInteractiveWindowRoots(
      StringBuilder xml,
      UiAutomation automation,
      int maxDepth,
      int maxNodes,
      AccessibilityTreeXml.Stats stats,
      String targetPackage) {
    List<AccessibilityWindowInfo> windows;
    try {
      windows = automation.getWindows();
    } catch (RuntimeException error) {
      return 0;
    }
    if (windows == null) {
      return 0;
    }

    int windowCount = 0;
    for (int index = 0; index < windows.size(); index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityWindowInfo window = windows.get(index);
      if (window == null) {
        continue;
      }
      AccessibilityNodeInfo root = null;
      boolean activeWindow = window.isActive();
      boolean focusedNonActiveWindow = !activeWindow && window.isFocused();
      try {
        AccessibilityTreeXml.WindowMetadata windowMetadata =
            AccessibilityTreeXml.readWindowMetadata(window, windowCount);
        root = window.getRoot();
        if (root == null) {
          stats.activeWindowRootMissing |= activeWindow;
          stats.focusedNonActiveWindowRootMissing |= focusedNonActiveWindow;
          if (activeWindow) {
            stats.activeWindowMetadata = windowMetadata;
          }
          continue;
        }
        AccessibilityTreeXml.appendNode(
            xml, root, windowCount, 0, maxDepth, maxNodes, stats, windowMetadata);
        windowCount += 1;
        // Accept active OR focused: some valid foreground states expose the app
        // window as focused-but-not-active. Either proves a real foreground
        // window root was appended.
        if (activeWindow || window.isFocused()) {
          stats.foregroundWindowObserved = true;
        }
        if (targetPackage != null && matchesPackage(root, targetPackage)) {
          stats.targetPackageMatched = true;
        }
      } catch (RuntimeException ignored) {
        // Windows can disappear mid-traversal; keep the rest of the snapshot.
        stats.activeWindowRootMissing |= activeWindow;
        stats.focusedNonActiveWindowRootMissing |= focusedNonActiveWindow;
      } finally {
        if (root != null) {
          root.recycle();
        }
        window.recycle();
      }
    }
    return windowCount;
  }

  /**
   * Whether an appended window root belongs to the requested package.
   *
   * <p>Read from the root's own {@code getPackageName()} rather than window
   * metadata, since the two can differ.
   */
  private static boolean matchesPackage(AccessibilityNodeInfo root, String targetPackage) {
    CharSequence packageName = root.getPackageName();
    return packageName != null && targetPackage.contentEquals(packageName);
  }

  static void enableInteractiveWindowRetrieval(UiAutomation automation) {
    AccessibilityServiceInfo serviceInfo;
    try {
      serviceInfo = automation.getServiceInfo();
    } catch (RuntimeException error) {
      return;
    }
    if (serviceInfo == null
        || (serviceInfo.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) {
      return;
    }
    serviceInfo.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    try {
      automation.setServiceInfo(serviceInfo);
    } catch (RuntimeException ignored) {
      // Fall back to active-window capture if the platform rejects dynamic flags.
    }
  }

  private static void clearAccessibilityCache(UiAutomation automation) {
    // Single-Activity Compose/Navigation apps render every destination inside one
    // AndroidComposeView. A reused UiAutomation connection's per-connection node
    // cache is not always invalidated by such an in-place swap, so clear it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      try {
        automation.clearCache();
        return;
      } catch (RuntimeException ignored) {
        // Fall through to the service-info reset below.
      }
    }
    try {
      automation.setServiceInfo(automation.getServiceInfo());
    } catch (RuntimeException ignored) {
      // Best effort.
    }
  }
}
