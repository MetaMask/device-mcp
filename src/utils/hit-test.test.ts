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

  describe('container of a label-matched target', () => {
    const label = el(
      'StaticText',
      { x: 170, y: 545, width: 60, height: 22 },
      { label: 'Unlock' },
    );

    it('accepts a larger button whose label relates to the target label', () => {
      expect(
        hitsTarget(
          label,
          el(
            'Button',
            { x: 16, y: 532, width: 370, height: 48 },
            { identifier: 'log-in-button', label: 'Unlock' },
          ),
        ),
      ).toBe(true);
    });

    it('accepts a button that joins the label with an icon name', () => {
      expect(
        hitsTarget(
          label,
          el(
            'Button',
            { x: 16, y: 532, width: 370, height: 48 },
            { label: 'Unlock, lock icon' },
          ),
        ),
      ).toBe(true);
    });

    it('rejects a label that merely contains the target label', () => {
      // Regression: "OK" is a substring of "Look at your balance", and
      // "Send" is a prefix of "Sending in progress". Neither is the button
      // around the target; both are sheets on top of it.
      const short = (text: string): UIElement =>
        el(
          'StaticText',
          { x: 170, y: 545, width: 60, height: 22 },
          { label: text },
        );

      expect(
        hitsTarget(
          short('OK'),
          el(
            'Other',
            { x: 0, y: 400, width: 402, height: 474 },
            { label: 'Look at your balance' },
          ),
        ),
      ).toBe(false);
      expect(
        hitsTarget(
          short('Send'),
          el(
            'Other',
            { x: 0, y: 400, width: 402, height: 474 },
            { label: 'Sending in progress' },
          ),
        ),
      ).toBe(false);
    });

    it('accepts a larger ancestor of the target whatever its label', () => {
      const container = el(
        'Button',
        { x: 16, y: 532, width: 370, height: 48 },
        { identifier: 'log-in-button', label: 'Sign in' },
      );

      expect(hitsTarget(label, container)).toBe(false);
      expect(hitsTarget(label, container, [container])).toBe(true);
    });

    it('rejects a larger overlay that only contains the target', () => {
      expect(
        hitsTarget(
          label,
          el(
            'Other',
            { x: 0, y: 400, width: 402, height: 474 },
            { label: 'Bottom sheet' },
          ),
        ),
      ).toBe(false);
      expect(
        hitsTarget(
          label,
          el(
            'Other',
            { x: 0, y: 400, width: 402, height: 474 },
            { identifier: 'modal-backdrop' },
          ),
        ),
      ).toBe(false);
    });

    it('rejects a larger element whose label is only whitespace', () => {
      expect(
        hitsTarget(
          el(
            'StaticText',
            { x: 170, y: 545, width: 60, height: 22 },
            { label: '  ' },
          ),
          el(
            'Other',
            { x: 16, y: 532, width: 370, height: 48 },
            { label: ' ' },
          ),
        ),
      ).toBe(false);
    });

    it('rejects a full-screen ancestor that matches an overlay backdrop', () => {
      const window = { width: 402, height: 874 };
      const confirm = el(
        'StaticText',
        { x: 100, y: 414, width: 60, height: 22 },
        { label: 'Confirm' },
      );
      const backdrop = el('Other', { x: 0, y: 0, width: 402, height: 874 });
      const button = el(
        'Button',
        { x: 20, y: 400, width: 360, height: 48 },
        { label: 'Primary action' },
      );

      // The backdrop is structurally the hierarchy root: an unlabelled
      // full-screen Other is indistinguishable from it.
      expect(hitsTarget(confirm, backdrop, [backdrop, button], window)).toBe(
        false,
      );
      // The hierarchy root stands in for the window when it is not passed.
      expect(hitsTarget(confirm, backdrop, [backdrop, button])).toBe(false);
    });

    it('accepts a non-full-screen unlabelled ancestor (a card)', () => {
      const window = { width: 402, height: 874 };
      const confirm = el(
        'StaticText',
        { x: 100, y: 414, width: 60, height: 22 },
        { label: 'Confirm' },
      );
      const root = el('Other', { x: 0, y: 0, width: 402, height: 874 });
      const card = el('Other', { x: 16, y: 380, width: 370, height: 120 });

      expect(hitsTarget(confirm, card, [root, card], window)).toBe(true);
    });

    it('accepts a button ancestor that is not full-screen', () => {
      const window = { width: 402, height: 874 };
      const confirm = el(
        'StaticText',
        { x: 100, y: 414, width: 60, height: 22 },
        { label: 'Confirm' },
      );
      const root = el('Other', { x: 0, y: 0, width: 402, height: 874 });
      const button = el(
        'Button',
        { x: 20, y: 400, width: 360, height: 48 },
        { label: 'Primary action' },
      );

      expect(hitsTarget(confirm, button, [root, button], window)).toBe(true);
    });

    it('rejects a larger keyboard element even when it is an ancestor', () => {
      const keyboard = el('Keyboard', {
        x: 0,
        y: 500,
        width: 402,
        height: 316,
      });

      expect(hitsTarget(label, keyboard)).toBe(false);
      expect(hitsTarget(label, keyboard, [keyboard])).toBe(false);
    });
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
