package io.metamask.devicemcp.snapshothelper;

import android.graphics.Rect;
import android.os.Build;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.Locale;

/**
 * Serializes an {@link AccessibilityNodeInfo} tree into UIAutomator-compatible
 * XML. The attribute vocabulary mirrors what stock `uiautomator dump` emits so
 * the existing host parser keeps working, plus per-window metadata on window
 * root nodes (multi-window capture is a departure from the single-tree dump).
 */
final class AccessibilityTreeXml {

  /** Mutable, shared traversal budget/telemetry across all windows in one capture. */
  static final class Stats {
    int nodeCount;
    boolean truncated;
    boolean activeWindowRootMissing;
    boolean focusedNonActiveWindowRootMissing;
    WindowMetadata activeWindowMetadata;
    // Positively set when an active/focused foreground window's root was
    // actually appended. Distinct from activeWindowRootMissing (an error
    // signal): this closes the hole where a capture containing only the
    // status bar (neither active nor focused) was silently accepted as
    // complete because no error flag was ever tripped.
    boolean foregroundWindowObserved;
    // Set when an appended window root's package matches the requested target
    // package (only consulted when a target package was provided).
    boolean targetPackageMatched;
  }

  /** Metadata describing a window, attached only to that window's root node. */
  static final class WindowMetadata {
    final int index;
    final int type;
    final int layer;
    final boolean active;
    final boolean focused;
    final Rect bounds;

    WindowMetadata(int index, int type, int layer, boolean active, boolean focused, Rect bounds) {
      this.index = index;
      this.type = type;
      this.layer = layer;
      this.active = active;
      this.focused = focused;
      this.bounds = bounds;
    }

    WindowMetadata withIndex(int newIndex) {
      return new WindowMetadata(newIndex, type, layer, active, focused, bounds);
    }
  }

  private AccessibilityTreeXml() {}

  static WindowMetadata readWindowMetadata(AccessibilityWindowInfo window, int index) {
    Rect bounds = new Rect();
    window.getBoundsInScreen(bounds);
    return new WindowMetadata(
        index,
        window.getType(),
        window.getLayer(),
        window.isActive(),
        window.isFocused(),
        bounds);
  }

  /**
   * Append a node and its subtree to {@code xml}.
   *
   * @param windowMetadata attached only on window roots; pass {@code null} for children.
   */
  @SuppressWarnings("deprecation")
  static void appendNode(
      StringBuilder xml,
      AccessibilityNodeInfo node,
      int nodeIndex,
      int depth,
      int maxDepth,
      int maxNodes,
      Stats stats,
      WindowMetadata windowMetadata) {
    if (stats.nodeCount >= maxNodes) {
      stats.truncated = true;
      return;
    }
    stats.nodeCount += 1;

    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);

    xml.append("<node");
    appendAttribute(xml, "index", Integer.toString(nodeIndex));
    if (windowMetadata != null) {
      appendWindowMetadata(xml, windowMetadata);
    }
    appendNonEmptyAttribute(xml, "text", node.getText());
    appendNonEmptyAttribute(xml, "resource-id", node.getViewIdResourceName());
    appendAttribute(xml, "class", node.getClassName());
    appendNonEmptyAttribute(xml, "package", node.getPackageName());
    appendNonEmptyAttribute(xml, "content-desc", node.getContentDescription());
    appendAttribute(xml, "visible-to-user", Boolean.toString(node.isVisibleToUser()));
    appendDrawingOrderAttribute(xml, node);
    appendAttribute(xml, "clickable", Boolean.toString(node.isClickable()));
    appendAttribute(xml, "enabled", Boolean.toString(node.isEnabled()));
    appendAttribute(xml, "focusable", Boolean.toString(node.isFocusable()));
    appendAttribute(xml, "focused", Boolean.toString(node.isFocused()));
    appendAttribute(xml, "long-clickable", Boolean.toString(node.isLongClickable()));
    appendAttribute(xml, "checkable", Boolean.toString(node.isCheckable()));
    appendAttribute(xml, "checked", Boolean.toString(node.isChecked()));
    appendAttribute(xml, "selected", Boolean.toString(node.isSelected()));

    boolean scrollable = node.isScrollable();
    appendAttribute(xml, "scrollable", Boolean.toString(scrollable));
    if (scrollable) {
      appendAttribute(
          xml,
          "can-scroll-forward",
          Boolean.toString(hasAction(node, AccessibilityAction.ACTION_SCROLL_FORWARD)));
      appendAttribute(
          xml,
          "can-scroll-backward",
          Boolean.toString(hasAction(node, AccessibilityAction.ACTION_SCROLL_BACKWARD)));
    }
    appendAttribute(xml, "password", Boolean.toString(node.isPassword()));
    appendAttribute(
        xml,
        "bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            bounds.left,
            bounds.top,
            bounds.right,
            bounds.bottom));

    int childCount = depth >= maxDepth ? 0 : node.getChildCount();
    if (depth >= maxDepth && node.getChildCount() > 0) {
      stats.truncated = true;
    }
    if (childCount <= 0) {
      xml.append(" />");
      return;
    }

    xml.append(">");
    for (int index = 0; index < childCount; index += 1) {
      if (stats.nodeCount >= maxNodes) {
        stats.truncated = true;
        break;
      }
      AccessibilityNodeInfo child = node.getChild(index);
      if (child == null) {
        continue;
      }
      try {
        appendNode(xml, child, index, depth + 1, maxDepth, maxNodes, stats, null);
      } finally {
        // Prevent native AccessibilityNodeInfo pool exhaustion.
        child.recycle();
      }
    }
    xml.append("</node>");
  }

  private static void appendWindowMetadata(StringBuilder xml, WindowMetadata metadata) {
    appendAttribute(xml, "window-index", Integer.toString(metadata.index));
    appendAttribute(xml, "window-type", Integer.toString(metadata.type));
    appendAttribute(xml, "window-layer", Integer.toString(metadata.layer));
    appendAttribute(xml, "window-active", Boolean.toString(metadata.active));
    appendAttribute(xml, "window-focused", Boolean.toString(metadata.focused));
    appendAttribute(
        xml,
        "window-bounds",
        String.format(
            Locale.ROOT,
            "[%d,%d][%d,%d]",
            metadata.bounds.left,
            metadata.bounds.top,
            metadata.bounds.right,
            metadata.bounds.bottom));
  }

  private static void appendDrawingOrderAttribute(StringBuilder xml, AccessibilityNodeInfo node) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      appendAttribute(xml, "drawing-order", Integer.toString(node.getDrawingOrder()));
    }
  }

  private static boolean hasAction(AccessibilityNodeInfo node, AccessibilityAction action) {
    return node.getActionList().contains(action);
  }

  private static void appendAttribute(StringBuilder xml, String name, CharSequence value) {
    xml.append(' ').append(name).append("=\"");
    appendEscaped(xml, value == null ? "" : value);
    xml.append('"');
  }

  private static void appendNonEmptyAttribute(StringBuilder xml, String name, CharSequence value) {
    appendAttribute(xml, name, value == null ? "" : value);
  }

  private static void appendEscaped(StringBuilder xml, CharSequence value) {
    for (int index = 0; index < value.length(); index += 1) {
      char character = value.charAt(index);
      switch (character) {
        case '&':
          xml.append("&amp;");
          break;
        case '<':
          xml.append("&lt;");
          break;
        case '>':
          xml.append("&gt;");
          break;
        case '"':
          xml.append("&quot;");
          break;
        case '\'':
          xml.append("&apos;");
          break;
        case '\n':
          xml.append("&#10;");
          break;
        case '\r':
          xml.append("&#13;");
          break;
        case '\t':
          xml.append("&#9;");
          break;
        default:
          xml.append(character);
      }
    }
  }
}
