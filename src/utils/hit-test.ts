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
 * identifier, or a frame inside the target's frame (1 pt tolerance).
 *
 * When the hit is larger than the target, it is accepted only as the target's
 * own container, and only from the target's ancestor chain:
 *
 * - the ancestor must not cover the screen (an unlabelled full-screen wrapper
 *   is indistinguishable from an overlay backdrop);
 * - it must have an identifier or a label, so it can be told apart from an
 *   overlay; with a label, the hit must carry the same label;
 * - identifiers must match exactly on both sides (or both be absent);
 * - no other element in the hierarchy may have the hit's type and frame (an
 *   absolute-fill veil can otherwise impersonate a real ancestor).
 *
 * With a non-empty ancestor chain the label rule is never consulted: React
 * Native Fabric joins any accessible container's child labels with `", "`, so
 * a sheet labelled `"Review transaction, 0.5 ETH, Cancel, Confirm"` would
 * otherwise be accepted for a `"Confirm"` target. Without a chain (flat idb
 * snapshots), the hit's label must carry the target's label exactly: equal
 * after trimming, lowercasing and collapsing whitespace, or equal to one of
 * the hit label's `", "` segments (`"Unlock, lock icon"` around `"Unlock"`).
 * No substring or prefix matching, and a hit that covers the screen is never
 * accepted this way. The flat rule does not cover React Native Paper (old
 * architecture), which joins labels with a space instead of `", "`; that
 * fails safe with TARGET_OBSCURED.
 *
 * @param target - The element the caller wants to tap.
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors in its snapshot, root first and
 * parent last. Omit or pass an empty array when the target has no known
 * ancestors (flat snapshot or copied element): the strict label rule is then
 * the only container signal.
 * @param window - The window size, when known, to refuse screen-covering
 * ancestors and hits. Without it, the hierarchy root's frame stands in.
 * @param hierarchy - The hierarchy the target came from, when known. Used to
 * refuse a hit that also matches an element off the target's ancestor chain.
 * @returns True when the tap reaches the target.
 */
export function hitsTarget(
  target: UIElement,
  hit: UIElement,
  ancestors: UIElement[] = [],
  window?: HitTestWindow,
  hierarchy?: UIElement[],
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
  if (!containsFrame(hit.frame, target.frame)) {
    return false;
  }
  const screen = window ?? ancestors[0]?.frame;
  if (ancestors.length === 0) {
    // No structure to trust: the strict label rule is the only signal, and a
    // screen-covering hit is never accepted through it.
    return (
      !coversScreen(hit.frame, screen) && labelCarries(target.label, hit.label)
    );
  }
  return ancestorProvesContainer(hit, ancestors, screen, hierarchy);
}

/**
 * Whether an ancestor of the target proves that the hit is the target's own
 * container: it matches the hit's type, frame, identifier and label, can be
 * told apart from an overlay, and no other element in the hierarchy matches
 * the hit.
 *
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors, root first.
 * @param screen - The screen size.
 * @param hierarchy - The hierarchy the target came from, when known.
 * @returns True when the ancestor chain proves the hit is the container.
 */
function ancestorProvesContainer(
  hit: UIElement,
  ancestors: UIElement[],
  screen: HitTestWindow | undefined,
  hierarchy: UIElement[] | undefined,
): boolean {
  const proved = ancestors.some((ancestor) =>
    ancestorMatchesHit(ancestor, hit, screen),
  );
  return proved && !hasSameFrameOutsideChain(hit, ancestors, hierarchy);
}

/**
 * Whether an ancestor can be the hit's element: same type and frame, same
 * identifiers, and a label the hit also carries. An ancestor with neither a
 * label nor an identifier cannot be told apart from an overlay, and a
 * screen-covering ancestor cannot either.
 *
 * @param ancestor - One of the target's ancestors.
 * @param hit - The element at the tap point.
 * @param screen - The screen size.
 * @returns True when the ancestor matches the hit and is identifiable.
 */
function ancestorMatchesHit(
  ancestor: UIElement,
  hit: UIElement,
  screen: HitTestWindow | undefined,
): boolean {
  if (coversScreen(ancestor.frame, screen)) {
    return false;
  }
  if (ancestor.type !== hit.type || !framesMatch(ancestor.frame, hit.frame)) {
    return false;
  }
  if ((ancestor.identifier ?? '') !== (hit.identifier ?? '')) {
    return false;
  }
  const label = normalizeLabel(ancestor.label);
  if (!label) {
    return Boolean(ancestor.identifier);
  }
  return label === normalizeLabel(hit.label);
}

/**
 * Whether the hierarchy has an element that matches the hit's type and frame
 * but is not on the target's ancestor chain. Such an element (for example an
 * absolute-fill loading veil) makes the hit ambiguous, so it is refused.
 *
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors, root first.
 * @param hierarchy - The hierarchy the target came from, when known.
 * @returns True when a same-type, same-frame element is off the chain.
 */
function hasSameFrameOutsideChain(
  hit: UIElement,
  ancestors: UIElement[],
  hierarchy: UIElement[] | undefined,
): boolean {
  if (!hierarchy) {
    return false;
  }
  const chain = new Set(ancestors);
  const walk = (elements: UIElement[]): boolean =>
    elements.some(
      (element) =>
        (element.type === hit.type &&
          framesMatch(element.frame, hit.frame) &&
          !chain.has(element)) ||
        (element.children ? walk(element.children) : false),
    );
  return walk(hierarchy);
}

/**
 * Whether the hit's label carries the target's label: equal after trimming,
 * lowercasing and collapsing whitespace (so `"1,000 USDC"` equals itself), or
 * equal to one of the hit label's `", "` segments. React Native Fabric joins
 * a container's child labels and icon names with `", "` (`"Unlock, lock
 * icon"`), so a button around a static text repeats it as a segment. No
 * substring or prefix matching: `"OK"` is not carried by `"Look at your
 * balance"`, nor `"Send"` by `"Sending in progress"`.
 *
 * @param target - The target's label.
 * @param hit - The hit's label.
 * @returns True when the hit carries the target's label.
 */
function labelCarries(
  target: string | undefined,
  hit: string | undefined,
): boolean {
  const wanted = normalizeLabel(target);
  const got = normalizeLabel(hit);
  if (!wanted || !got) {
    return false;
  }
  if (wanted === got) {
    return true;
  }
  return `, ${got}, `.includes(`, ${wanted}, `);
}

/**
 * A label normalized for comparison: trimmed, lowercased, whitespace runs
 * collapsed to one space.
 *
 * @param label - The label.
 * @returns The normalized label, or an empty string.
 */
function normalizeLabel(label: string | undefined): string {
  return (label ?? '').trim().toLowerCase().replace(/\s+/gu, ' ');
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
