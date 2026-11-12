import { describeElement } from './element.js';
import type { UIElement } from '../backends/types.js';

/** Element types of the iOS software keyboard and its accessory bar. */
const KEYBOARD_TYPES = new Set(['Keyboard', 'Key']);

/** Labels of the keyboard's input-assistant bar (AutoFill / Passwords). */
const KEYBOARD_ASSISTANT_LABELS = new Set(['Passwords']);

/** Frame comparison tolerance, in points. */
const FRAME_TOLERANCE = 1;

/** The window size, in points. */
export type HitTestWindow = { width: number; height: number };

/**
 * A tap would land on another element than the target: an overlay, a sheet,
 * or the software keyboard. Nothing was tapped.
 */
export class TargetObscuredError extends Error {
  readonly code = 'TARGET_OBSCURED' as const;

  /** The element at the tap point. */
  readonly obscuredBy: UIElement;

  /** True when the obscuring element belongs to the software keyboard. */
  readonly keyboard: boolean;

  readonly x: number;

  readonly y: number;

  constructor(
    target: UIElement,
    obscuredBy: UIElement,
    point: { x: number; y: number },
  ) {
    const keyboard = isKeyboardElement(obscuredBy);
    const advice = keyboard
      ? 'Dismiss the keyboard (device_dismiss_keyboard) and retry.'
      : 'Close the overlay, or scroll the target into a free area.';
    super(
      `TARGET_OBSCURED: ${describeElement(target)} is covered at ` +
        `(${point.x}, ${point.y}) by ${keyboard ? 'the keyboard: ' : ''}` +
        `${describeElement(obscuredBy)}. Nothing was tapped. ${advice}`,
    );
    this.name = 'TargetObscuredError';
    this.obscuredBy = obscuredBy;
    this.keyboard = keyboard;
    this.x = point.x;
    this.y = point.y;
  }
}

/**
 * Whether `hit` (the element at the tap point) is the target, part of it, or
 * its own container.
 *
 * The hit-test returns the deepest accessible element, which can be a child
 * of the target (a label inside a button), so "part of" means: same
 * identifier, or a frame inside the target's frame (1 pt tolerance). It can
 * also be the target's container when the query matched a label or text (the
 * button whose label is the matched static text). A container is accepted
 * only when its frame contains the target's frame and it is provably the
 * target's own: it is one of the `ancestors` from the snapshot the target
 * came from, or it carries the target's label exactly (equal after trimming
 * and ignoring case, or as one of its comma-separated segments, as iOS joins
 * a container's child labels and icon names: "Unlock, lock icon"). Nothing
 * else is a match: "OK" is not carried by "Look at your balance". A larger
 * overlay, sheet, backdrop or keyboard that merely contains the target is
 * still refused.
 *
 * @param target - The element the caller wants to tap.
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors in its snapshot, root first and
 * parent last. Omit when the hierarchy is unavailable (for example for an
 * element copied from another snapshot): the strict label rule is then the
 * only container signal.
 * @param window - The window size, when known. An ancestor that covers the
 * whole window (1 pt tolerance) never proves the hit is the target's
 * container: React Native screens have several unlabelled full-screen
 * wrappers, and an overlay's backdrop looks exactly like them. Without it,
 * the hierarchy root's frame is used instead.
 * @returns True when the tap reaches the target.
 */
export function hitsTarget(
  target: UIElement,
  hit: UIElement,
  ancestors: UIElement[] = [],
  window?: HitTestWindow,
): boolean {
  if (isKeyboardElement(hit)) {
    return false;
  }
  if (target.identifier && hit.identifier === target.identifier) {
    return true;
  }
  if (containsFrame(target.frame, hit.frame)) {
    return true;
  }
  return (
    containsFrame(hit.frame, target.frame) &&
    isOwnContainer(target, hit, ancestors, window)
  );
}

/**
 * Whether the hit is the target's own container: an ancestor in the snapshot
 * that can be told apart from an overlay, or an element that carries the
 * target's label.
 *
 * @param target - The element the caller wants to tap.
 * @param hit - The element at the tap point, whose frame contains the target's.
 * @param ancestors - The target's ancestors, root first.
 * @param window - The window size, when known.
 * @returns True when the hit is the target's container, not an overlay.
 */
function isOwnContainer(
  target: UIElement,
  hit: UIElement,
  ancestors: UIElement[],
  window: HitTestWindow | undefined,
): boolean {
  // Without the window size, the hierarchy root stands in for it: an ancestor
  // that covers the root is indistinguishable from an overlay backdrop too.
  const screen = window ?? ancestors[0]?.frame;
  const isAncestor = ancestors.some(
    (ancestor) =>
      !coversScreen(ancestor.frame, screen) &&
      ancestor.type === hit.type &&
      framesMatch(ancestor.frame, hit.frame) &&
      (!ancestor.identifier ||
        !hit.identifier ||
        ancestor.identifier === hit.identifier),
  );
  return isAncestor || labelCarries(target.label, hit.label);
}

/**
 * Whether a frame covers the whole screen (1 pt tolerance). An unlabelled
 * full-screen wrapper is indistinguishable from an overlay backdrop, so it
 * cannot prove that a hit is the target's container.
 *
 * @param frame - The frame to test.
 * @param screen - The screen size, when known. Without it, no frame is
 * considered full-screen.
 * @returns True when the frame covers the screen.
 */
function coversScreen(
  frame: UIElement['frame'],
  screen: HitTestWindow | undefined,
): boolean {
  if (!screen) {
    return false;
  }
  return (
    frame.x <= FRAME_TOLERANCE &&
    frame.y <= FRAME_TOLERANCE &&
    frame.x + frame.width >= screen.width - FRAME_TOLERANCE &&
    frame.y + frame.height >= screen.height - FRAME_TOLERANCE
  );
}

/**
 * Whether the hit's label carries the target's label exactly: equal after
 * trimming and ignoring case, or equal to one of the hit label's
 * comma-separated segments. iOS joins a container's child labels and icon
 * names with ", " ("Unlock, lock icon"), so a button around a static text
 * repeats it as a segment. No substring or prefix matching: "OK" is not
 * carried by "Look at your balance", nor "Send" by "Sending in progress".
 *
 * @param target - The target's label.
 * @param hit - The hit's label.
 * @returns True when the hit carries the target's label.
 */
function labelCarries(
  target: string | undefined,
  hit: string | undefined,
): boolean {
  const wanted = target?.trim().toLowerCase();
  if (!wanted) {
    return false;
  }
  return (
    hit
      ?.split(',')
      .some((segment) => segment.trim().toLowerCase() === wanted) ?? false
  );
}

/**
 * Whether `outer` contains `inner`, with 1 pt tolerance.
 *
 * @param outer - The containing frame.
 * @param inner - The contained frame.
 * @returns True when `inner` lies inside `outer`.
 */
function containsFrame(
  outer: UIElement['frame'],
  inner: UIElement['frame'],
): boolean {
  return (
    inner.x >= outer.x - FRAME_TOLERANCE &&
    inner.y >= outer.y - FRAME_TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + FRAME_TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + FRAME_TOLERANCE
  );
}

/**
 * Whether two frames are the same, with 1 pt tolerance.
 *
 * @param a - One frame.
 * @param b - The other frame.
 * @returns True when each frame contains the other.
 */
function framesMatch(a: UIElement['frame'], b: UIElement['frame']): boolean {
  return containsFrame(a, b) && containsFrame(b, a);
}

/**
 * Whether the element is part of the software keyboard: a key, the keyboard
 * itself, or its AutoFill bar ("Passwords").
 *
 * @param element - The element.
 * @returns True for keyboard elements.
 */
export function isKeyboardElement(element: UIElement): boolean {
  return (
    KEYBOARD_TYPES.has(element.type) ||
    (element.type === 'Button' &&
      KEYBOARD_ASSISTANT_LABELS.has(element.label ?? ''))
  );
}
