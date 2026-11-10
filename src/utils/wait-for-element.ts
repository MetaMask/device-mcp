import { findElement, sameFrame } from './element.js';
import type {
  ElementQuery,
  SnapshotResult,
  UIElement,
} from '../backends/types.js';

/** Extra reads that wait for an element that just appeared to stop moving. */
const MAX_SETTLE_READS = 3;

/**
 * Poll snapshots until an element matches `query`.
 *
 * An element that is on screen at the first read is returned at once. An
 * element that appears later can still be animating in (a sheet sliding up),
 * so the screen is read again until its frame is the same in two reads in a
 * row (at most `MAX_SETTLE_READS` extra reads). Callers tap the returned
 * frame, so it must be where the element stops.
 *
 * @param snapshot - Reads the screen.
 * @param query - The element to wait for.
 * @param timeoutMs - Maximum time to wait for the element to appear.
 * @param intervalMs - Delay between reads while the element is missing.
 * @returns The element, at its settled frame when it appeared during the wait.
 */
export async function pollForElement(
  snapshot: () => Promise<SnapshotResult>,
  query: ElementQuery,
  timeoutMs: number,
  intervalMs: number,
): Promise<UIElement> {
  const start = Date.now();
  const timeLeft = (): boolean => Date.now() - start < timeoutMs;
  for (let poll = 0; timeLeft(); poll++) {
    const element = findElement((await snapshot()).hierarchy, query);
    if (element) {
      if (poll === 0) {
        return element;
      }
      const settled = await settle(snapshot, query, element, timeLeft);
      if (settled) {
        return settled;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `Timed out waiting for element: ${JSON.stringify(query)} (${timeoutMs}ms)`,
  );
}

/**
 * Read the screen until the element's frame stops changing.
 *
 * @param snapshot - Reads the screen.
 * @param query - The element.
 * @param first - The element as first found.
 * @param timeLeft - Whether the wait's timeout has not passed yet.
 * @returns The element at its last frame (still moving when the reads or the
 * timeout run out), or null when it disappeared.
 */
async function settle(
  snapshot: () => Promise<SnapshotResult>,
  query: ElementQuery,
  first: UIElement,
  timeLeft: () => boolean,
): Promise<UIElement | null> {
  let previous = first;
  for (let i = 0; i < MAX_SETTLE_READS && timeLeft(); i++) {
    const next = findElement((await snapshot()).hierarchy, query);
    if (!next || sameFrame(next, previous)) {
      return next;
    }
    previous = next;
  }
  return previous;
}
