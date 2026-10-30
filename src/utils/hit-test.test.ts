import { describe, expect, it } from 'vitest';

import { hitsTarget, isKeyboardElement } from './hit-test.js';
import type { UIElement } from '../backends/types.js';

const el = (
  type: string,
  frame: UIElement['frame'],
  extra: Partial<UIElement> = {},
): UIElement => ({ type, frame, enabled: true, ...extra });

const target = el(
  'Button',
  { x: 16, y: 532, width: 370, height: 48 },
  { identifier: 'log-in-button', label: 'Unlock' },
);

describe('hitsTarget', () => {
  it('accepts the target itself', () => {
    expect(hitsTarget(target, { ...target })).toBe(true);
  });

  it('accepts an element with the same identifier, whatever its frame', () => {
    expect(
      hitsTarget(
        target,
        el(
          'Other',
          { x: 0, y: 0, width: 1, height: 1 },
          { identifier: 'log-in-button' },
        ),
      ),
    ).toBe(true);
  });

  it('accepts a child inside the target frame (1 pt tolerance)', () => {
    expect(
      hitsTarget(
        target,
        el('StaticText', { x: 15.5, y: 540, width: 100, height: 20 }),
      ),
    ).toBe(true);
  });

  it('rejects a larger element around the target (a sheet or container)', () => {
    expect(
      hitsTarget(
        target,
        el('Other', { x: 0, y: 400, width: 402, height: 474 }),
      ),
    ).toBe(false);
  });

  it('rejects an overlapping sibling that sticks out of the target', () => {
    expect(
      hitsTarget(
        target,
        el(
          'Button',
          { x: 30, y: 560, width: 342, height: 44 },
          { label: 'Close' },
        ),
      ),
    ).toBe(false);
  });

  it('rejects keyboard elements even inside the target frame', () => {
    expect(
      hitsTarget(
        target,
        el(
          'Button',
          { x: 30, y: 546, width: 342, height: 44 },
          { label: 'Passwords' },
        ),
      ),
    ).toBe(false);
    expect(
      hitsTarget(target, el('Key', { x: 100, y: 540, width: 30, height: 30 })),
    ).toBe(false);
  });
});

describe('isKeyboardElement', () => {
  it.each([
    [el('Keyboard', { x: 0, y: 590, width: 402, height: 226 }), true],
    [el('Key', { x: 0, y: 0, width: 1, height: 1 }, { label: 'g' }), true],
    [
      el('Button', { x: 0, y: 0, width: 1, height: 1 }, { label: 'Passwords' }),
      true,
    ],
    [
      el('Button', { x: 0, y: 0, width: 1, height: 1 }, { label: 'Unlock' }),
      false,
    ],
    [
      el('KeyboardControllerView', { x: 0, y: 0, width: 402, height: 874 }),
      false,
    ],
  ])('%#: %j -> %s', (element, expected) => {
    expect(isKeyboardElement(element)).toBe(expected);
  });
});
