import { describe, expect, it, vi } from 'vitest';

import {
  isInViewport,
  scrollUntilInViewport,
  ScrollToElementError,
  swipeToward,
} from './scroll.js';
import type { SnapshotResult, UIElement } from '../backends/types.js';

const windowSize = { width: 402, height: 874 };

const node = (label: string, y: number, height = 24): UIElement => ({
  type: 'StaticText',
  label,
  frame: { x: 16, y, width: 370, height },
  enabled: true,
});

const snap = (elements: UIElement[]): SnapshotResult => ({
  platform: 'ios',
  hierarchy: elements,
  raw: JSON.stringify(elements),
  timestamp: 0,
});

/**
 * A scrolling list: rows at fixed content offsets, and a scroll offset that a
 * finger-up swipe increases by `step` (clamped to [0, maxOffset]).
 *
 * @param rows - Content rows: label and content y.
 * @param options - Scroll step, end of the list, fixed (non-scrolling) rows.
 * @param options.step - Points moved per swipe.
 * @param options.maxOffset - Largest scroll offset (end of the list).
 * @param options.fixed - Rows that do not scroll (e.g. a footer button).
 * @returns Backend stubs and the swipe log.
 */
function list(
  rows: [string, number][],
  {
    step = 350,
    maxOffset = 2000,
    fixed = [] as UIElement[],
  }: { step?: number; maxOffset?: number; fixed?: UIElement[] } = {},
): {
  deps: Parameters<typeof scrollUntilInViewport>[0];
  swipes: string[];
} {
  let offset = 0;
  const swipes: string[] = [];
  return {
    swipes,
    deps: {
      windowSize,
      snapshot: vi.fn(async () =>
        snap([...rows.map(([label, y]) => node(label, y - offset)), ...fixed]),
      ),
      swipe: vi.fn(async (finger: 'up' | 'down') => {
        swipes.push(finger);
        offset = Math.min(
          maxOffset,
          Math.max(0, offset + (finger === 'up' ? step : -step)),
        );
      }),
    },
  };
}

describe('isInViewport', () => {
  it('rejects an element that is in the tree but below the fold', () => {
    expect(isInViewport(node('Account icon', 996), windowSize)).toBe(false);
  });

  it('rejects an element hidden under the bottom inset', () => {
    // 874 * 0.96 = 839: only 9 of 24 pt are above the inset.
    expect(isInViewport(node('Row', 830), windowSize)).toBe(false);
  });

  it('accepts an element that is fully in view', () => {
    expect(isInViewport(node('Row', 400), windowSize)).toBe(true);
  });

  it('accepts a tall element once 44 pt of it are in view', () => {
    expect(isInViewport(node('Card', 780, 600), windowSize)).toBe(true);
    expect(isInViewport(node('Card', 800, 600), windowSize)).toBe(false);
  });

  it('rejects a zero-height frame (Android clips hidden rows to the list edge)', () => {
    expect(isInViewport(node('Currency', 210, 0), windowSize)).toBe(false);
  });

  it('rejects an element outside the viewport horizontally', () => {
    const element = {
      ...node('Row', 400),
      frame: { x: 500, y: 400, width: 100, height: 24 },
    };
    expect(isInViewport(element, windowSize)).toBe(false);
  });
});

describe('swipeToward', () => {
  it('swipes up (reveals content below) for an element below the middle', () => {
    expect(swipeToward(node('Row', 996), windowSize)).toBe('up');
  });

  it('swipes down (reveals content above) for an element above the middle', () => {
    expect(swipeToward(node('Row', -300), windowSize)).toBe('down');
  });
});

describe('scrollUntilInViewport', () => {
  it('does not swipe when the element is already in view', async () => {
    const { deps, swipes } = list([['Account icon', 400]]);

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Account icon' },
      'auto',
      10,
    );

    expect(result).toMatchObject({ swipes: 0, inViewport: true });
    expect(swipes).toStrictEqual([]);
  });

  it('swipes when the element is in the tree but off-screen, and returns it in view', async () => {
    // The 2026-10-28 bug: found in the tree at y=996, returned after 0 swipes.
    const { deps, swipes } = list([['Account icon', 996]]);

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Account icon' },
      'auto',
      10,
    );

    expect(swipes).toStrictEqual(['up']);
    expect(result.swipes).toBe(1);
    expect(result.inViewport).toBe(true);
    expect(result.element.frame.y).toBe(646);
    expect(isInViewport(result.element, windowSize)).toBe(true);
  });

  it('auto swipes down for an element above the viewport', async () => {
    const { deps, swipes } = list([['Header', 400]]);
    // Start scrolled down by 700 pt: Header is at y=-300, above the viewport.
    await deps.swipe('up');
    await deps.swipe('up');
    swipes.length = 0;

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Header' },
      'auto',
      10,
    );

    expect(swipes[0]).toBe('down');
    expect(result.inViewport).toBe(true);
  });

  it('auto searches below first, then turns around when the list ends', async () => {
    // The element is not in the tree until scrolled back to the top.
    let offset = 700;
    const swipes: string[] = [];
    const deps = {
      windowSize,
      snapshot: vi.fn(async () =>
        snap(offset === 0 ? [node('Top', 200)] : [node(`at ${offset}`, 400)]),
      ),
      swipe: vi.fn(async (finger: 'up' | 'down') => {
        swipes.push(finger);
        offset = Math.min(
          700,
          Math.max(0, offset + (finger === 'up' ? 350 : -350)),
        );
      }),
    };

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Top' },
      'auto',
      10,
    );

    // up (already at the end: no change) -> turn -> down, down.
    expect(swipes).toStrictEqual(['up', 'down', 'down']);
    expect(result).toMatchObject({ swipes: 3, inViewport: true });
  });

  it('honours an explicit finger direction', async () => {
    const { deps, swipes } = list([['Account icon', 996]]);

    await expect(
      scrollUntilInViewport(deps, { label: 'Account icon' }, 'down', 3),
    ).rejects.toMatchObject({
      code: 'ELEMENT_NOT_IN_VIEWPORT',
      frame: { y: 996 },
    });
    // Finger down at the top of the list moves nothing: stop after one swipe.
    expect(swipes).toStrictEqual(['down']);
  });

  it('fails with the last frame when the list ends before the element is in view', async () => {
    const { deps, swipes } = list([['Footer note', 2000]], { maxOffset: 500 });

    const error = await scrollUntilInViewport(
      deps,
      { label: 'Footer note' },
      'auto',
      10,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrollToElementError);
    expect(error).toMatchObject({
      code: 'ELEMENT_NOT_IN_VIEWPORT',
      frame: { y: 1500 },
    });
    expect((error as Error).message).toContain('after 3 swipe(s)');
    expect((error as Error).message).toContain('at (16, 1500 370x24)');
    expect(swipes).toStrictEqual(['up', 'up', 'up']);
  });

  it('fails with ELEMENT_NOT_FOUND when the element never appears', async () => {
    const { deps } = list([['Row', 400]], { maxOffset: 0 });

    await expect(
      scrollUntilInViewport(deps, { label: 'Missing' }, 'auto', 10),
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_FOUND', swipes: 2 });
  });

  it('stops after maxAttempts swipes', async () => {
    const { deps, swipes } = list([['Far', 20000]], { maxOffset: 100000 });

    await expect(
      scrollUntilInViewport(deps, { label: 'Far' }, 'auto', 4),
    ).rejects.toMatchObject({ code: 'ELEMENT_NOT_IN_VIEWPORT', swipes: 4 });
    expect(swipes).toHaveLength(4);
  });

  it('accepts a fixed element that the swipe does not move', async () => {
    // A footer button under the bottom inset never scrolls into the inset area.
    const footer = node('Continue', 840, 30);
    const { deps, swipes } = list([['Row', 400]], { fixed: [footer] });

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Continue' },
      'auto',
      10,
    );

    expect(swipes).toStrictEqual(['up']);
    expect(result).toMatchObject({ swipes: 1, inViewport: true });
  });

  it('waits for the scroll to settle before returning', async () => {
    // After the swipe, momentum moves the row 100 pt more over two reads.
    const ys = [996, 646, 546, 546];
    let read = 0;
    const deps = {
      windowSize,
      snapshot: vi.fn(async () =>
        snap([
          node('Account icon', ys[Math.min((read += 1) - 1, ys.length - 1)]),
        ]),
      ),
      swipe: vi.fn(async () => undefined),
    };

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Account icon' },
      'auto',
      10,
    );

    expect(result.element.frame.y).toBe(546);
    expect(deps.snapshot).toHaveBeenCalledTimes(4);
  });

  it('keeps scrolling when momentum carries the element out of view', async () => {
    // In view right after the swipe, but the scroll keeps going past it.
    const ys = [996, 400, -200, -200, 400, 400];
    let read = 0;
    const swipes: string[] = [];
    const deps = {
      windowSize,
      snapshot: vi.fn(async () =>
        snap([node('Row', ys[Math.min((read += 1) - 1, ys.length - 1)])]),
      ),
      swipe: vi.fn(async (finger: 'up' | 'down') => {
        swipes.push(finger);
      }),
    };

    const result = await scrollUntilInViewport(
      deps,
      { label: 'Row' },
      'auto',
      10,
    );

    expect(swipes).toStrictEqual(['up', 'down']);
    expect(result).toMatchObject({ swipes: 2, inViewport: true });
    expect(result.element.frame.y).toBe(400);
  });
});
