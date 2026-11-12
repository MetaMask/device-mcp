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
 * The hit-test returns the deepest accessible element, which can be a child of
 * the target (a label inside a button): a hit with the target's identifier, or
 * with a frame inside the target's frame (1 pt tolerance), reaches the target.
 *
 * A larger hit is accepted only as the target's own container, proved in one
 * of two ways (`ancestorProvesContainer` and `flatLabelProvesContainer`):
 *
 * - from the target's ancestor chain, when an ancestor matches the hit exactly
 *   and is identifiable, does not cover the screen, and no other element in
 *   the hierarchy matches the hit (which would make the hit ambiguous);
 * - from the label rule, when there is no chain and the structure is flat: the
 *   hit is not an `Other`, does not cover the screen, and its label carries
 *   the target's label exactly.
 *
 * A nested hierarchy without the target in it (a copy, or an element from an
 * earlier snapshot) is unknown structure, so no larger hit is accepted. The
 * keyboard is always refused.
 *
 * @param target - The element the caller wants to tap.
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors in its snapshot, root first and
 * parent last; empty when the target has none (a flat snapshot or a hierarchy
 * root), and `null` when the target is not in the hierarchy (a copy, or an
 * element from another snapshot). With `null`, a larger hit is refused for a
 * nested hierarchy and the label rule only applies to a flat one.
 * @param window - The window size, when known, to refuse screen-covering
 * ancestors and hits. Without it, the hierarchy root's frame stands in.
 * @param hierarchy - The hierarchy the target came from, when known. Used to
 * refuse a hit that also matches an element off the target's ancestor chain.
 * @returns True when the tap reaches the target.
 */
export function hitsTarget(
  target: UIElement,
  hit: UIElement,
  ancestors: UIElement[] | null = [],
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

  const screen = window ?? ancestors?.[0]?.frame;
  if (ancestors?.length) {
    return ancestorProvesContainer(hit, ancestors, screen, hierarchy);
  }
  if (hierarchy && isNestedHierarchy(hierarchy)) {
    // The target is not in a nested hierarchy (a copy, or an element from
    // another snapshot), so there is no chain to prove its container.
    return false;
  }
  return flatLabelProvesContainer(target, hit, screen);
}

/**
 * Whether any element in the hierarchy has children, i.e. the snapshot
 * describes a tree rather than a flat list.
 *
 * @param elements - The hierarchy to inspect.
 * @returns True when at least one element has children.
 */
function isNestedHierarchy(elements: UIElement[]): boolean {
  return elements.some((element) => (element.children?.length ?? 0) > 0);
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
  return proved && !anotherElementMatchesHit(hit, ancestors, hierarchy);
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
 * Whether the hierarchy has an element that matches the hit's type, frame,
 * label and identifier but is not on the target's ancestor chain. Such an
 * element (for example an absolute-fill loading veil) makes the hit ambiguous,
 * so it is refused; an unrelated decoration with the same frame (a same-frame
 * background inside the button) does not.
 *
 * @param hit - The element at the tap point.
 * @param ancestors - The target's ancestors, root first.
 * @param hierarchy - The hierarchy the target came from, when known.
 * @returns True when another element matches the hit off the chain.
 */
function anotherElementMatchesHit(
  hit: UIElement,
  ancestors: UIElement[],
  hierarchy: UIElement[] | undefined,
): boolean {
  if (!hierarchy) {
    return false;
  }
  const chain = new Set(ancestors);
  const matchesHit = (element: UIElement): boolean =>
    element.type === hit.type &&
    framesMatch(element.frame, hit.frame) &&
    normalizeLabel(element.label) === normalizeLabel(hit.label) &&
    (element.identifier ?? '') === (hit.identifier ?? '');
  const walk = (elements: UIElement[]): boolean =>
    elements.some(
      (element) =>
        (matchesHit(element) && !chain.has(element)) ||
        (element.children ? walk(element.children) : false),
    );
  return walk(hierarchy);
}

/**
 * Whether the flat-snapshot label rule accepts a larger hit: the hit is not an
 * `Other`, does not cover the screen, and its label carries the target's
 * label.
 *
 * `Other` containers aggregate their children's labels (sheets, toasts), and a
 * screen-covering hit is an overlay backdrop, so neither can pass for the
 * target's own container.
 *
 * Only used when the target has no ancestor chain: React Native Fabric joins a
 * container's child labels with `", "`, so a sheet labelled `"Review
 * transaction, 0.5 ETH, Cancel, Confirm"` would otherwise be accepted for a
 * `"Confirm"` target.
 *
 * @param target - The element the caller wants to tap.
 * @param hit - The element at the tap point.
 * @param screen - The screen size.
 * @returns True when the label rule proves the hit is the target's container.
 */
function flatLabelProvesContainer(
  target: UIElement,
  hit: UIElement,
  screen: HitTestWindow | undefined,
): boolean {
  return (
    hit.type !== 'Other' &&
    !coversScreen(hit.frame, screen) &&
    labelCarries(target.label, hit.label)
  );
}

/**
 * Whether the hit's label carries the target's label: equal after trimming,
 * lowercasing and collapsing whitespace (so `"1,000 USDC"` equals itself), or
 * equal to one of the hit label's `", "` segments. React Native Fabric joins
 * a container's child labels and icon names with `", "` (`"Unlock, lock
 * icon"`), so a button around a static text repeats it as a segment. No
 * substring or prefix matching: `"OK"` is not carried by `"Look at your
 * balance"`, nor `"Send"` by `"Sending in progress"`. React Native Paper (old
 * architecture) joins labels with a space instead, which never matches, so the
 * tap is refused: fail-safe, not a false accept.
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
  // Wrap both sides so that a match at either end still counts as a segment.
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
