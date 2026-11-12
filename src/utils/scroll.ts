import { describeElement, findElement, sameFrame } from './element.js';
import type {
  ElementQuery,
  ScrollDirection,
  ScrollToElementResult,
  SnapshotResult,
  UIElement,
  WindowSize,
} from '../backends/types.js';

/**
 * Part of the viewport height kept clear at the top and at the bottom when
 * deciding whether an element is in view (about 35 pt on an 874 pt iPhone):
 * the status bar and the iOS home indicator overlay the scrolled content.
 */
const VIEWPORT_INSET = 0.04;

/** A tall element counts as in view once this many points of it are. */
const MIN_VISIBLE = 44;

/** Extra reads, after the target is in view, to let the scroll momentum stop. */
const MAX_SETTLE_READS = 3;

export type ScrollToElementErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_IN_VIEWPORT';

/**
 * `scrollToElement` could not bring the element into view. `code` tells
 * whether the element was never in the UI tree (`ELEMENT_NOT_FOUND`) or was
 * found but stayed outside the viewport (`ELEMENT_NOT_IN_VIEWPORT`, with its
 * last `frame`).
 */
export class ScrollToElementError extends Error {
  readonly code: ScrollToElementErrorCode;

  readonly swipes: number;

  readonly frame: UIElement['frame'] | undefined;

  constructor(
    code: ScrollToElementErrorCode,
    message: string,
    details: { swipes: number; frame?: UIElement['frame'] },
  ) {
    super(message);
    this.name = 'ScrollToElementError';
    this.code = code;
    this.swipes = details.swipes;
    this.frame = details.frame;
  }
}

/**
 * Whether enough of the element is inside the viewport, after removing
 * {@link VIEWPORT_INSET} at the top and bottom, to see and tap it: half of
 * its height, or {@link MIN_VISIBLE} points for a tall element. A zero-size
 * frame is never in view.
 *
 * @param element - The element.
 * @param windowSize - The viewport size, in the same units as the frame.
 * @param windowSize.width - Viewport width.
 * @param windowSize.height - Viewport height.
 * @returns True when the element is in view.
 */
export function isInViewport(
  element: UIElement,
  { width, height }: WindowSize,
): boolean {
  const { x, y, width: w, height: h } = element.frame;
  const top = Math.max(y, height * VIEWPORT_INSET);
  const bottom = Math.min(y + h, height * (1 - VIEWPORT_INSET));
  const visibleWidth = Math.min(x + w, width) - Math.max(x, 0);
  const visibleHeight = bottom - top;
  // Android clips an off-screen node's bounds to the edge of its scroll
  // container, so a hidden row can be reported with zero height.
  return (
    visibleWidth > 0 &&
    visibleHeight > 0 &&
    visibleHeight >= Math.min(h / 2, MIN_VISIBLE)
  );
}

/**
 * Whether any part of the element is inside the viewport (the rule a tap
 * uses).
 *
 * @param element - The element.
 * @param windowSize - The viewport size.
 * @param windowSize.width - Viewport width.
 * @param windowSize.height - Viewport height.
 * @returns True when the frame intersects the viewport.
 */
function intersectsViewport(
  element: UIElement,
  { width, height }: WindowSize,
): boolean {
  const { x, y, width: w, height: h } = element.frame;
  return (
    Math.min(x + w, width) > Math.max(x, 0) &&
    Math.min(y + h, height) > Math.max(y, 0)
  );
}

/**
 * The finger direction that brings an off-screen element toward the middle
 * of the viewport: up for an element below it (reveals content below), down
 * for one above it.
 *
 * @param element - The element.
 * @param windowSize - The viewport size.
 * @returns The swipe direction.
 */
export function swipeToward(
  element: UIElement,
  windowSize: WindowSize,
): 'up' | 'down' {
  const centerY = element.frame.y + element.frame.height / 2;
  return centerY > windowSize.height / 2 ? 'up' : 'down';
}

export type ScrollDeps = {
  snapshot: () => Promise<SnapshotResult>;
  windowSize: WindowSize;
  /** One scroll gesture; `direction` is the finger direction. */
  swipe: (direction: 'up' | 'down') => Promise<void>;
};

/**
 * Swipe until the element matching `query` is in the viewport.
 *
 * Finding the element in the UI tree is not enough: React Native keeps
 * off-screen rows in the accessibility tree, so the element must also pass
 * {@link isInViewport}. An element that a swipe did not move while the screen
 * changed is fixed (for example a footer button) and is accepted when it
 * intersects the viewport. After a swipe, the screen is read again until it
 * stops changing (scroll momentum) before the result is returned.
 *
 * `direction` is the finger direction. With `auto`, the direction comes from
 * the element's position; while the element is not in the tree, the search
 * goes toward content below (finger up) and turns around once when the
 * screen stops changing.
 *
 * @param deps - Backend operations.
 * @param query - The element to bring into view.
 * @param direction - Finger direction, or `auto`.
 * @param maxSwipes - Maximum number of swipes.
 * @returns The element as last read, the number of swipes, `inViewport: true`.
 * @throws {ScrollToElementError} When the element is not in view after
 * `maxSwipes`, or the screen stops changing first.
 */
export async function scrollUntilInViewport(
  deps: ScrollDeps,
  query: ElementQuery,
  direction: ScrollDirection,
  maxSwipes: number,
): Promise<ScrollToElementResult> {
  const { windowSize } = deps;
  let search: 'up' | 'down' = direction === 'down' ? 'down' : 'up';
  let turned = direction !== 'auto';
  let swipes = 0;
  let snap = await deps.snapshot();
  let previousRaw: string | undefined;
  let last: UIElement | null = null;

  for (;;) {
    const element = findElement(snap.hierarchy, query);
    if (element) {
      const fixed =
        last !== null &&
        swipes > 0 &&
        snap.raw !== previousRaw &&
        sameFrame(element, last) &&
        intersectsViewport(element, windowSize);
      last = element;
      if (fixed) {
        // Does not scroll with the content, so momentum cannot move it.
        return { element, swipes, inViewport: true };
      }
      if (isInViewport(element, windowSize)) {
        const settled = swipes === 0 ? null : await settle(deps, snap);
        if (!settled) {
          return { element, swipes, inViewport: true };
        }
        const settledElement = findElement(settled.hierarchy, query);
        if (settledElement && isInViewport(settledElement, windowSize)) {
          return { element: settledElement, swipes, inViewport: true };
        }
        // Momentum carried it out of view: judge again from the settled screen.
        snap = settled;
        continue;
      }
    }
    if (snap.raw === previousRaw) {
      // The last swipe moved nothing: the end of the list in this direction.
      if (!element && !turned) {
        turned = true;
        search = search === 'up' ? 'down' : 'up';
      } else {
        break;
      }
    }
    if (swipes >= maxSwipes) {
      break;
    }
    const next =
      direction === 'auto' && element
        ? swipeToward(element, windowSize)
        : search;
    previousRaw = snap.raw;
    await deps.swipe(next);
    swipes += 1;
    snap = await deps.snapshot();
  }

  if (!last) {
    throw new ScrollToElementError(
      'ELEMENT_NOT_FOUND',
      `Element not found after ${swipes} swipe(s): ${JSON.stringify(query)}\n` +
        'Use device_snapshot to inspect the current UI hierarchy.',
      { swipes },
    );
  }
  const { frame } = last;
  const [x, y, w, h] = [frame.x, frame.y, frame.width, frame.height].map(
    Math.round,
  );
  throw new ScrollToElementError(
    'ELEMENT_NOT_IN_VIEWPORT',
    `Element is outside the ${windowSize.width}x${windowSize.height} viewport ` +
      `after ${swipes} swipe(s): ${describeElement(last)} at ` +
      `(${x}, ${y} ${w}x${h}).`,
    { swipes, frame },
  );
}

/**
 * Read the screen until two reads are equal, so a scroll that is still moving
 * is not judged mid-flight.
 *
 * @param deps - Backend operations.
 * @param first - The read that found the element in view.
 * @returns The settled read, or null when the first read was already settled.
 */
async function settle(
  deps: ScrollDeps,
  first: SnapshotResult,
): Promise<SnapshotResult | null> {
  let previous = first;
  for (let i = 0; i < MAX_SETTLE_READS; i++) {
    const snap = await deps.snapshot();
    if (snap.raw === previous.raw) {
      return i === 0 ? null : snap;
    }
    previous = snap;
  }
  return previous;
}
