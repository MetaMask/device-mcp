import { describe, it, expect, vi } from 'vitest';

import { pollForElement } from './wait-for-element.js';
import type { SnapshotResult, UIElement } from '../backends/types.js';

const sheetButton = (y: number): UIElement => ({
  type: 'Button',
  identifier: 'confirm',
  frame: { x: 20, y, width: 200, height: 44 },
  enabled: true,
});

const screen = (...hierarchy: UIElement[]): SnapshotResult => ({
  platform: 'ios',
  hierarchy,
  raw: JSON.stringify(hierarchy),
  timestamp: 0,
});

/**
 * A snapshot reader that returns the given screens in order, then repeats the
 * last one.
 *
 * @param screens - The screens to return.
 * @returns The mock reader.
 */
function reads(...screens: SnapshotResult[]): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const next = screens[Math.min(i, screens.length - 1)];
    i += 1;
    return next;
  });
}

describe('pollForElement', () => {
  const query = { identifier: 'confirm' };

  it('returns an element that is on screen at the first read at once', async () => {
    const snapshot = reads(screen(sheetButton(700)), screen(sheetButton(500)));

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(700),
    );
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('waits for an element that appears during the wait to stop moving', async () => {
    const snapshot = reads(
      screen(),
      screen(sheetButton(800)),
      screen(sheetButton(600)),
      screen(sheetButton(500)),
      screen(sheetButton(500)),
    );

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(500),
    );
    expect(snapshot).toHaveBeenCalledTimes(5);
  });

  it('returns an element that appeared already settled after one more read', async () => {
    const snapshot = reads(screen(), screen(sheetButton(500)));

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(500),
    );
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('returns the last frame when the element is still moving after the extra reads', async () => {
    const snapshot = reads(
      screen(),
      screen(sheetButton(800)),
      screen(sheetButton(700)),
      screen(sheetButton(600)),
      screen(sheetButton(500)),
      screen(sheetButton(400)),
    );

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(500),
    );
    expect(snapshot).toHaveBeenCalledTimes(5);
  });

  it('keeps polling when the element disappears while settling', async () => {
    const snapshot = reads(
      screen(),
      screen(sheetButton(800)),
      screen(),
      screen(sheetButton(500)),
      screen(sheetButton(500)),
    );

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(500),
    );
    expect(snapshot).toHaveBeenCalledTimes(5);
  });

  it('does not read again to settle once the timeout has passed', async () => {
    const now = vi.spyOn(Date, 'now');
    // start, first poll, second poll, then the timeout has passed.
    now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2_000);
    const snapshot = reads(screen(), screen(sheetButton(800)));

    expect(await pollForElement(snapshot, query, 1_000, 0)).toStrictEqual(
      sheetButton(800),
    );
    expect(snapshot).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('throws when the element does not appear before the timeout', async () => {
    const snapshot = reads(screen());

    await expect(pollForElement(snapshot, query, 30, 5)).rejects.toThrow(
      'Timed out waiting for element: {"identifier":"confirm"} (30ms)',
    );
  });
});
