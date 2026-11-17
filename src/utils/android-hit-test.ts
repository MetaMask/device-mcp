import { hitsTarget, TargetObscuredError } from './hit-test.js';
import type { HitTestWindow } from './hit-test.js';
import type { UIElement } from '../backends/types.js';

/** `AccessibilityWindowInfo.TYPE_INPUT_METHOD`: the software keyboard. */
const WINDOW_TYPE_INPUT_METHOD = 2;

type Frame = UIElement['frame'];

/**
 * A wrapper with a drawn node inside counts as drawn over its whole frame
 * when its area is at most this many times the area its drawn nodes cover.
 */
const WRAPPER_MAX_AREA_RATIO = 2;

/**
 * ...or when each side is at most this share of the window's shorter side
 * (a small overlay button: the Expo "Tools" background is 137 px around a
 * 68 px icon on a 1080 px wide screen).
 */
const WRAPPER_SMALL_SIDE_RATIO = 0.2;

/**
 * A non-clickable leaf with no text, content-desc or resource id is a
 * transparent host, not a surface, when it covers at least this share of the
 * window's area (or its full width).
 */
const LARGE_LEAF_AREA_RATIO = 0.5;

/** Window metadata the snapshot helper puts on each window root. */
export type AndroidWindowInfo = {
  type: number;
  layer: number;
  bounds: Frame;
};

/**
 * What the Android hierarchy XML says about a node beyond `UIElement`. Only
 * set for nodes parsed by `parseAndroidHierarchy`.
 */
export type AndroidNodeInfo = {
  /** The parsed hierarchy (all window roots) the node belongs to. */
  roots: UIElement[];
  /** The parent node; undefined for a window root. */
  parent: UIElement | undefined;
  /** Draw order among siblings (higher is drawn later, on top). */
  drawingOrder: number | undefined;
  visibleToUser: boolean;
  clickable: boolean;
  /** Set on window roots captured by the snapshot helper. */
  window: AndroidWindowInfo | undefined;
};

const nodeInfo = new WeakMap<UIElement, AndroidNodeInfo>();

/**
 * Record the Android-only data of a parsed node.
 *
 * @param element - The parsed node.
 * @param info - Its Android data.
 */
export function setAndroidNodeInfo(
  element: UIElement,
  info: AndroidNodeInfo,
): void {
  nodeInfo.set(element, info);
}

/**
 * Whether the snapshot `target` came from has an input-method (keyboard)
 * window above the target's window. Only then is the keyboard's touchable
 * region worth reading (see {@link parseInputMethodTouchableRegion}).
 *
 * @param target - The element to tap.
 * @returns True when a keyboard window is above the target's window.
 */
export function hasInputMethodAbove(target: UIElement): boolean {
  const info = nodeInfo.get(target);
  const targetRoot = ancestorChain(target)[0] ?? target;
  const targetWindow = nodeInfo.get(targetRoot)?.window;
  if (!info || !targetWindow) {
    return false;
  }
  return info.roots.some((root) => {
    const window = nodeInfo.get(root)?.window;
    return (
      window?.type === WINDOW_TYPE_INPUT_METHOD &&
      window.layer > targetWindow.layer
    );
  });
}

/**
 * Read the keyboard's touchable region from `dumpsys window InputMethod`:
 * the `touchable region=SkRegion((l,t,r,b)…)` of each input-method window
 * (`ty=INPUT_METHOD`) that is visible (`isVisible=true`), in screen pixels.
 *
 * This is where the keyboard takes touches right now, whatever its
 * accessibility tree shows. Gboard's floating toolbar (hardware keyboard on)
 * is `(94,137,225,262)(21,863,169,1553)(0,2337,1080,2400)`: the suggestion
 * key, the toolbar, and the navigation bar strip. The accessibility tree can
 * miss the suggestion key, and the window bounds lag behind it.
 *
 * @param dump - The `dumpsys window InputMethod` output.
 * @returns The rects; empty when no keyboard window is visible; undefined
 * when a visible keyboard window has no readable region (unknown).
 */
export function parseInputMethodTouchableRegion(
  dump: string,
): Frame[] | undefined {
  const rects: Frame[] = [];
  for (const block of dump.split(/^\s*Window #\d+ /mu).slice(1)) {
    if (!/\bty=INPUT_METHOD\b/u.test(block)) {
      continue;
    }
    if (!/\bisVisible=true\b/u.test(block)) {
      continue;
    }
    const region =
      /touchable region=SkRegion\(((?:\(-?\d+,-?\d+,-?\d+,-?\d+\))*)\)/u.exec(
        block,
      );
    if (!region) {
      return undefined;
    }
    for (const [, left, top, right, bottom] of (region[1] ?? '').matchAll(
      /\((-?\d+),(-?\d+),(-?\d+),(-?\d+)\)/gu,
    )) {
      const frame = {
        x: Number(left),
        y: Number(top),
        width: Number(right) - Number(left),
        height: Number(bottom) - Number(top),
      };
      if (hasArea(frame)) {
        rects.push(frame);
      }
    }
  }
  return rects;
}

/**
 * Find what a tap at `point` would hit instead of `target`, from the
 * snapshot the target came from, and, while a keyboard is up, the keyboard's
 * touchable region read at tap time.
 *
 * - A higher window (the keyboard, a system window): any drawn node of it at
 * the point. A window's root frame is often the whole screen and
 * transparent, so only nodes that draw or take input count (clickable,
 * labelled, or leaves).
 * - The keyboard's touchable region (`options.keyboardRegion`), when the
 * caller read it: a point inside it is refused as the keyboard, even when the
 * snapshot has no keyboard node there. Gboard's floating suggestion key is
 * sometimes missing from the accessibility tree, and the keyboard window's
 * bounds lag behind what is drawn, so neither can stand in for it. The
 * window bounds or the drawn keys widened to the full width would also
 * refuse free targets on the upper screen, because with a hardware keyboard
 * the window is much larger than its keys.
 * - The target's window: a node drawn after the target (higher
 * `drawing-order` where the two branches split) that contains the point and
 * draws there (see `drawsItself` and `drawsAt`).
 *
 * `hitsTarget` then decides, as on iOS, whether the node is part of the
 * target. Deliberate trade-off: it accepts any node whose frame lies inside
 * the target's. Here that node is never the target's descendant
 * (`drawnAfter` excludes those), but a sibling drawn on top; React Native
 * draws a control's content that way (a field's input over its container, a
 * label or icon over a pressable's background). So a sibling overlay that
 * fits inside the target is a false accept, not a refusal.
 *
 * The check fails open (the tap goes ahead) when nothing can be told:
 *
 * - the target's window root has no window metadata: a stock `uiautomator
 * dump` (the fallback), which has no `window-*` or `visible-to-user`, and
 * from android15-qpr2 on has `drawing-order`;
 * - the element is not a node of a parsed snapshot: a copy, or an
 * `options.element` that went through JSON, has no recorded node data.
 *
 * A helper tree cut at `maxNodes` can miss the nodes drawn last, so an
 * overlay there is not seen and the tap goes ahead (a false accept, never a
 * false refusal).
 *
 * @param target - The element to tap.
 * @param point - The tap point.
 * @param point.x - X in pixels.
 * @param point.y - Y in pixels.
 * @param screen - The screen size in pixels.
 * @param options - Data read from the device at tap time.
 * @param options.keyboardRegion - The keyboard's touchable region, from
 * {@link parseInputMethodTouchableRegion}. Omit when there is no keyboard
 * window in the snapshot, or the region can't be read.
 * @throws {TargetObscuredError} When another node is on top at the point.
 */
export function assertAndroidHittable(
  target: UIElement,
  point: { x: number; y: number },
  screen: HitTestWindow,
  options: { keyboardRegion?: Frame[] } = {},
): void {
  const info = nodeInfo.get(target);
  if (!info) {
    return;
  }
  const chain = ancestorChain(target);
  const targetRoot = chain[0] ?? target;
  const targetWindow = nodeInfo.get(targetRoot)?.window;
  if (!targetWindow) {
    return;
  }

  const higher = info.roots
    .filter((root) => {
      const window = nodeInfo.get(root)?.window;
      return root !== targetRoot && window && window.layer > targetWindow.layer;
    })
    .sort(
      (a, b) =>
        (nodeInfo.get(b)?.window?.layer ?? 0) -
        (nodeInfo.get(a)?.window?.layer ?? 0),
    );
  for (const root of higher) {
    const window = nodeInfo.get(root)?.window as AndroidWindowInfo;
    const hit = deepest(
      root,
      (node) => contains(node.frame, point) && drawsItself(node, window.bounds),
    );
    if (hit) {
      const keyboard = window.type === WINDOW_TYPE_INPUT_METHOD;
      throw new TargetObscuredError(target, hit, point, {
        keyboard,
        // Keyboard ids are obfuscated and say nothing; the class is enough.
        obscuredByDescription: keyboard ? hit.type : describeObscurer(hit),
      });
    }
  }

  const keyboardRect = options.keyboardRegion?.find((rect) =>
    contains(rect, point),
  );
  if (keyboardRect) {
    const keyboardRoot =
      info.roots.find(
        (root) => nodeInfo.get(root)?.window?.type === WINDOW_TYPE_INPUT_METHOD,
      ) ?? targetRoot;
    throw new TargetObscuredError(target, keyboardRoot, point, {
      keyboard: true,
      obscuredByDescription: `touchable area ${formatRect(keyboardRect)}`,
    });
  }

  const windowBounds = targetWindow.bounds;
  const hits = matching(
    targetRoot,
    (node) =>
      node !== target &&
      contains(node.frame, point) &&
      drawnAfter(node, target) &&
      drawsAt(node, windowBounds),
  );
  // Deepest and last drawn first, so the error names what is really on top.
  for (const hit of hits.reverse()) {
    if (!hitsTarget(target, hit, chain, screen, info.roots)) {
      throw new TargetObscuredError(target, hit, point, {
        keyboard: false,
        obscuredByDescription: describeObscurer(hit),
      });
    }
  }
}

/**
 * @param element - A parsed node.
 * @returns Its ancestors, root first and parent last.
 */
function ancestorChain(element: UIElement): UIElement[] {
  const chain: UIElement[] = [];
  let parent = nodeInfo.get(element)?.parent;
  while (parent) {
    chain.unshift(parent);
    parent = nodeInfo.get(parent)?.parent;
  }
  return chain;
}

/**
 * The last node in tree order that matches, which is the deepest and the
 * last drawn among matching siblings.
 *
 * @param root - The subtree to search.
 * @param matches - The predicate.
 * @returns The node, or undefined.
 */
function deepest(
  root: UIElement,
  matches: (node: UIElement) => boolean,
): UIElement | undefined {
  return matching(root, matches).at(-1);
}

/**
 * @param root - The subtree to search.
 * @param matches - The predicate.
 * @returns The matching nodes, in tree order.
 */
function matching(
  root: UIElement,
  matches: (node: UIElement) => boolean,
): UIElement[] {
  const found: UIElement[] = [];
  const walk = (node: UIElement): void => {
    if (matches(node)) {
      found.push(node);
    }
    node.children?.forEach(walk);
  };
  walk(root);
  return found;
}

/**
 * Whether `node` is drawn after (on top of) `target`: where their branches
 * split, the node's branch has the higher `drawing-order`. Ancestors and
 * descendants of the target are never drawn after it.
 *
 * @param node - A node in the target's window.
 * @param target - The target.
 * @returns True when the node is drawn on top of the target.
 */
function drawnAfter(node: UIElement, target: UIElement): boolean {
  const nodeChain = [...ancestorChain(node), node];
  const targetChain = [...ancestorChain(target), target];
  let split = 0;
  while (
    split < nodeChain.length &&
    split < targetChain.length &&
    nodeChain[split] === targetChain[split]
  ) {
    split += 1;
  }
  if (split === 0 || split >= nodeChain.length || split >= targetChain.length) {
    return false;
  }
  const nodeOrder = nodeInfo.get(nodeChain[split])?.drawingOrder;
  const targetOrder = nodeInfo.get(targetChain[split])?.drawingOrder;
  return (
    nodeOrder !== undefined &&
    targetOrder !== undefined &&
    nodeOrder > targetOrder
  );
}

/**
 * Whether a node draws or takes input itself: visible, with an area, not the
 * size of its window, and clickable, labelled, or a leaf.
 *
 * A large leaf that is not clickable and has no text, content-desc or
 * resource id is not counted: React Native renders absolute-fill hosts and
 * `box-none` / `pointerEvents="none"` layers as such leaves. Without
 * edge-to-edge they are inset (below the status bar, `[0,63][1080,2400]`),
 * so they are not window-sized. "Large" is at least half the window's area,
 * or its full width (a transparent header layer such as `[0,50][1080,400]`).
 * A real full-width surface still counts when it is clickable or labelled,
 * or as a wrapper around drawn nodes (`drawsAt`).
 *
 * @param node - The node.
 * @param window - Its window's bounds.
 * @returns True when the node draws.
 */
function drawsItself(node: UIElement, window: Frame): boolean {
  const info = nodeInfo.get(node);
  if (!info?.visibleToUser || !hasArea(node.frame)) {
    return false;
  }
  if (containsFrame(node.frame, window)) {
    return false;
  }
  if (info.clickable || node.label || node.value) {
    return true;
  }
  if (node.children?.length) {
    return false;
  }
  if (node.identifier) {
    return true;
  }
  const large =
    node.frame.width >= window.width ||
    area(node.frame) >= area(window) * LARGE_LEAF_AREA_RATIO;
  return !large;
}

/**
 * Whether a node in the target's window draws at its frame: it draws itself,
 * or it is a wrapper close around nodes that do (an overlay button's
 * background around its icon).
 *
 * A wrapper counts only when its area is at most
 * {@link WRAPPER_MAX_AREA_RATIO} times the area its drawn nodes cover, or when
 * it is small (each side at most {@link WRAPPER_SMALL_SIDE_RATIO} of the
 * window's shorter side). A larger wrapper is a transparent layout container
 * (a `box-none` host around a floating button, or a row as wide as the
 * window); its drawn children still count on their own.
 *
 * @param node - The node.
 * @param window - The window's bounds.
 * @returns True when the node covers what is under it.
 */
function drawsAt(node: UIElement, window: Frame): boolean {
  if (drawsItself(node, window)) {
    return true;
  }
  const info = nodeInfo.get(node);
  if (!info?.visibleToUser || !hasArea(node.frame)) {
    return false;
  }
  if (node.frame.width >= window.width) {
    return false;
  }
  const drawn = drawnDescendantsInside(node, node.frame, window);
  if (drawn.length === 0) {
    return false;
  }
  const smallSide =
    Math.min(window.width, window.height) * WRAPPER_SMALL_SIDE_RATIO;
  if (node.frame.width <= smallSide && node.frame.height <= smallSide) {
    return true;
  }
  return area(node.frame) <= unionArea(drawn) * WRAPPER_MAX_AREA_RATIO;
}

/**
 * @param node - The node.
 * @param frame - The wrapper's frame.
 * @param window - Its window's bounds.
 * @returns The frames of the descendants that draw themselves inside `frame`.
 */
function drawnDescendantsInside(
  node: UIElement,
  frame: Frame,
  window: Frame,
): Frame[] {
  return (node.children ?? []).flatMap((child) => [
    ...(drawsItself(child, window) && containsFrame(frame, child.frame)
      ? [child.frame]
      : []),
    ...drawnDescendantsInside(child, frame, window),
  ]);
}

/**
 * @param frames - Frames.
 * @returns The area of their union.
 */
function unionArea(frames: Frame[]): number {
  const xs = [
    ...new Set(frames.flatMap((frame) => [frame.x, frame.x + frame.width])),
  ].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const left = xs[i];
    const right = xs[i + 1];
    const spans = frames
      .filter((frame) => frame.x <= left && frame.x + frame.width >= right)
      .map((frame) => [frame.y, frame.y + frame.height] as const)
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [top, bottom] of spans) {
      if (bottom > end) {
        covered += bottom - Math.max(top, end);
        end = bottom;
      }
    }
    total += covered * (right - left);
  }
  return total;
}

/**
 * A description of the obscuring node. An unnamed wrapper (an overlay
 * button's background) is named by the first labelled node inside it.
 *
 * @param node - The obscuring node.
 * @returns The description, or undefined to use the default.
 */
function describeObscurer(node: UIElement): string | undefined {
  if (node.label ?? node.identifier ?? node.value) {
    return undefined;
  }
  const named = findNamed(node);
  return named ? `${node.type} around ${describeNamed(named)}` : undefined;
}

/**
 * @param node - The node.
 * @returns The first descendant with a label, identifier or value.
 */
function findNamed(node: UIElement): UIElement | undefined {
  for (const child of node.children ?? []) {
    if (child.label ?? child.identifier ?? child.value) {
      return child;
    }
    const below = findNamed(child);
    if (below) {
      return below;
    }
  }
  return undefined;
}

/**
 * @param node - A named node.
 * @returns Its type and names.
 */
function describeNamed(node: UIElement): string {
  const parts = [node.type];
  if (node.label) {
    parts.push(`label="${node.label}"`);
  }
  if (node.identifier) {
    parts.push(`id="${node.identifier}"`);
  }
  if (node.value) {
    parts.push(`value="${node.value}"`);
  }
  return parts.join(' ');
}

/**
 * @param frame - A frame.
 * @returns It as Android bounds, `[left,top][right,bottom]`.
 */
function formatRect(frame: Frame): string {
  return `[${frame.x},${frame.y}][${frame.x + frame.width},${frame.y + frame.height}]`;
}

/**
 * @param frame - A frame.
 * @returns Its area.
 */
function area(frame: Frame): number {
  return frame.width * frame.height;
}

/**
 * @param frame - A frame.
 * @returns True when it has a positive width and height.
 */
function hasArea(frame: Frame): boolean {
  return frame.width > 0 && frame.height > 0;
}

/**
 * @param frame - A frame.
 * @param point - A point.
 * @param point.x - X.
 * @param point.y - Y.
 * @returns True when the point is inside the frame (right and bottom edges
 * excluded, as Android bounds are).
 */
function contains(frame: Frame, point: { x: number; y: number }): boolean {
  return (
    point.x >= frame.x &&
    point.x < frame.x + frame.width &&
    point.y >= frame.y &&
    point.y < frame.y + frame.height
  );
}

/**
 * @param outer - The containing frame.
 * @param inner - The contained frame.
 * @returns True when `inner` lies inside `outer`.
 */
function containsFrame(outer: Frame, inner: Frame): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
