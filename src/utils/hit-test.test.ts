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

  describe('larger hit: the target container or an overlay', () => {
    const window = { width: 402, height: 874 };
    const label = el(
      'StaticText',
      { x: 170, y: 545, width: 60, height: 22 },
      { label: 'Unlock' },
    );

    describe('flat snapshot (label rule only)', () => {
      it('accepts a larger button with the target label', () => {
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

      it('rejects a larger overlay with an unrelated label or identifier', () => {
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

      it('matches a label with a comma by full equality', () => {
        const amount = el(
          'StaticText',
          { x: 100, y: 414, width: 90, height: 22 },
          { label: '1,000 USDC' },
        );
        const row = el('Button', { x: 16, y: 400, width: 360, height: 48 });

        expect(hitsTarget(amount, { ...row, label: '1,000 USDC' })).toBe(true);
        expect(hitsTarget(amount, { ...row, label: 'Total: 1,000 USDC' })).toBe(
          false,
        );
      });

      it('rejects a full-screen labelled hit', () => {
        expect(
          hitsTarget(
            label,
            el(
              'Other',
              { x: 0, y: 0, width: 402, height: 874 },
              { label: 'Unlock' },
            ),
            [],
            window,
          ),
        ).toBe(false);
      });

      it('rejects a Fabric-aggregated Other label', () => {
        // `Other` containers aggregate their children's labels (RN sheets and
        // toasts), so they are never accepted through the flat label rule.
        expect(
          hitsTarget(
            el(
              'StaticText',
              { x: 120, y: 610, width: 150, height: 24 },
              { label: 'Confirm' },
            ),
            el(
              'Other',
              { x: 0, y: 400, width: 390, height: 444 },
              { label: 'Review transaction, 0.5 ETH, Cancel, Confirm' },
            ),
            [],
            window,
          ),
        ).toBe(false);
      });
    });

    describe('unknown structure (the target is not in the hierarchy)', () => {
      const confirmText = el(
        'StaticText',
        { x: 100, y: 414, width: 60, height: 22 },
        { label: 'Confirm' },
      );
      const largerButton = el(
        'Button',
        { x: 0, y: 400, width: 390, height: 444 },
        { label: 'Confirm' },
      );

      it('refuses a larger hit when the hierarchy is nested', () => {
        // `null` means "not in the hierarchy" (a copy, or an element from
        // another snapshot). The hierarchy proves the app is nested, so the
        // target must have had ancestors: the structure is unknown and the
        // flat label rule must not run.
        const root = el('Application', {
          x: 0,
          y: 0,
          width: 390,
          height: 844,
        });
        root.children = [el('Other', { x: 0, y: 0, width: 390, height: 100 })];

        expect(
          hitsTarget(confirmText, largerButton, null, window, [root]),
        ).toBe(false);
      });

      it('applies the label rule when the hierarchy is flat', () => {
        const flat = [
          el(
            'Button',
            { x: 16, y: 400, width: 360, height: 48 },
            { label: 'Confirm' },
          ),
        ];

        expect(hitsTarget(confirmText, largerButton, null, window, flat)).toBe(
          true,
        );
      });

      it('applies the label rule when no hierarchy is passed', () => {
        expect(hitsTarget(confirmText, largerButton, null, window)).toBe(true);
      });
    });

    describe('nested snapshot (ancestor rule only)', () => {
      const app = el('Application', { x: 0, y: 0, width: 402, height: 874 });
      const confirmText = el(
        'StaticText',
        { x: 100, y: 414, width: 60, height: 22 },
        { label: 'Confirm' },
      );
      const button = el(
        'Button',
        { x: 20, y: 400, width: 360, height: 48 },
        { label: 'Primary action', identifier: 'primary-btn' },
      );
      button.children = [confirmText];
      app.children = [button];

      it('accepts an identifiable ancestor whose label the hit repeats', () => {
        expect(hitsTarget(confirmText, button, [app, button], window)).toBe(
          true,
        );
      });

      it('rejects an unlabelled, unidentified ancestor that matches an overlay', () => {
        // An absoluteFill loading veil has the same frame as a wrapper; an
        // unlabelled Other ancestor cannot prove it is the target's container.
        const veil = el('Other', { x: 0, y: 100, width: 390, height: 661 });
        const confirm = el(
          'Button',
          { x: 100, y: 300, width: 190, height: 48 },
          { label: 'Confirm' },
        );
        const screen = el('Application', {
          x: 0,
          y: 0,
          width: 390,
          height: 844,
        });
        veil.children = [confirm];
        screen.children = [veil];

        expect(
          hitsTarget(confirm, veil, [screen, veil], {
            width: 390,
            height: 844,
          }),
        ).toBe(false);
      });

      it('rejects an overlay with an identifier when the ancestor has none', () => {
        const veil = el('Other', { x: 0, y: 100, width: 390, height: 661 });
        const confirm = el(
          'Button',
          { x: 100, y: 300, width: 190, height: 48 },
          { label: 'Confirm' },
        );
        const screen = el('Application', {
          x: 0,
          y: 0,
          width: 390,
          height: 844,
        });
        veil.children = [confirm];
        screen.children = [veil];

        expect(
          hitsTarget(
            confirm,
            el('Other', veil.frame, { identifier: 'loading-overlay' }),
            [screen, veil],
            { width: 390, height: 844 },
          ),
        ).toBe(false);
      });

      it('rejects an ancestor whose identifier differs from the hit', () => {
        expect(
          hitsTarget(
            confirmText,
            { ...button, identifier: 'other-btn' },
            [app, button],
            window,
          ),
        ).toBe(false);
      });

      it('rejects an ancestor whose label differs from the hit label', () => {
        expect(
          hitsTarget(
            confirmText,
            { ...button, label: 'Loading' },
            [app, button],
            window,
          ),
        ).toBe(false);
      });

      it('rejects an ancestor when another element matches the hit frame', () => {
        // A same-frame Button off the target's chain makes the hit ambiguous.
        const decoy = { ...button };
        const withDecoy = el('Application', app.frame);
        withDecoy.children = [button, decoy];
        const hit = { ...button };

        expect(
          hitsTarget(confirmText, hit, [app, button], window, [withDecoy]),
        ).toBe(false);
        // Without the hierarchy the ambiguity cannot be seen.
        expect(hitsTarget(confirmText, hit, [app, button], window)).toBe(true);
      });

      it('accepts a button with a same-frame decoration of another type', () => {
        // A Button "Swap" wraps a same-frame decorative Other. The hit is the
        // button: the decoration cannot make it ambiguous, since only a
        // same-type, same-frame element with the same label and identifier
        // can impersonate it.
        const swapText = el(
          'StaticText',
          { x: 100, y: 414, width: 60, height: 22 },
          { label: 'Swap' },
        );
        const swapButton = el(
          'Button',
          { x: 20, y: 400, width: 360, height: 48 },
          { label: 'Swap', identifier: 'swap-btn' },
        );
        const decoration = el('Other', swapButton.frame, {
          label: 'Decorative background',
        });
        swapButton.children = [decoration, swapText];
        const root = el('Application', app.frame);
        root.children = [swapButton];

        expect(
          hitsTarget(swapText, { ...swapButton }, [root, swapButton], window, [
            root,
          ]),
        ).toBe(true);
      });

      it('accepts a hit when an off-chain same-frame element has another label', () => {
        // Same type and frame, but a different label and identifier: an
        // unrelated control, not an impersonating veil.
        const decoy = el('Button', button.frame, {
          label: 'Other action',
          identifier: 'other-btn',
        });
        const withDecoy = el('Application', app.frame);
        withDecoy.children = [button, decoy];

        expect(
          hitsTarget(confirmText, { ...button }, [app, button], window, [
            withDecoy,
          ]),
        ).toBe(true);
      });

      it('accepts a non-full-screen card ancestor with an identifier', () => {
        const root = el('Other', app.frame);
        const card = el(
          'Other',
          { x: 16, y: 380, width: 370, height: 120 },
          { identifier: 'summary-card' },
        );
        card.children = [confirmText];
        root.children = [card];

        expect(
          hitsTarget(confirmText, card, [root, card], window, [root]),
        ).toBe(true);
      });

      it('accepts a non-full-screen card ancestor with a label', () => {
        const root = el('Other', app.frame);
        const card = el(
          'Other',
          { x: 16, y: 380, width: 370, height: 120 },
          { label: 'Summary' },
        );
        card.children = [confirmText];
        root.children = [card];

        expect(
          hitsTarget(confirmText, card, [root, card], window, [root]),
        ).toBe(true);
      });

      it('rejects an unlabelled, unidentified card ancestor', () => {
        const root = el('Other', app.frame);
        const card = el('Other', { x: 16, y: 380, width: 370, height: 120 });
        card.children = [confirmText];
        root.children = [card];

        expect(
          hitsTarget(confirmText, card, [root, card], window, [root]),
        ).toBe(false);
      });

      it('rejects a full-screen ancestor', () => {
        const backdrop = el('Other', { x: 0, y: 0, width: 402, height: 874 });
        const deepButton = el(
          'Button',
          { x: 20, y: 400, width: 360, height: 48 },
          { label: 'Primary action' },
        );

        expect(
          hitsTarget(confirmText, backdrop, [backdrop, deepButton], window),
        ).toBe(false);
        // The hierarchy root stands in for the window when it is not passed.
        expect(hitsTarget(confirmText, backdrop, [backdrop, deepButton])).toBe(
          false,
        );
      });

      it('rejects an aggregated Fabric sheet label', () => {
        // The ancestor chain is non-empty: the label rule is not consulted,
        // so "Confirm" inside a sheet's aggregated label cannot pass.
        const screen = el('Application', {
          x: 0,
          y: 0,
          width: 390,
          height: 844,
        });
        const confirmButton = el(
          'Button',
          { x: 100, y: 600, width: 190, height: 48 },
          { label: 'Confirm', identifier: 'confirm-btn' },
        );
        const confirmTarget = el(
          'StaticText',
          { x: 120, y: 610, width: 150, height: 24 },
          { label: 'Confirm' },
        );
        confirmButton.children = [confirmTarget];
        screen.children = [confirmButton];

        expect(
          hitsTarget(
            confirmTarget,
            el(
              'Other',
              { x: 0, y: 400, width: 390, height: 444 },
              { label: 'Review transaction, 0.5 ETH, Cancel, Confirm' },
            ),
            [screen, confirmButton],
            { width: 390, height: 844 },
            [screen],
          ),
        ).toBe(false);
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
