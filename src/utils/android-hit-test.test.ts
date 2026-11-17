import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assertAndroidHittable } from './android-hit-test.js';
import { findElement, visibleCenter } from './element.js';
import { TargetObscuredError } from './hit-test.js';
import { parseAndroidHierarchy } from '../backends/adb-backend.js';
import type { UIElement } from '../backends/types.js';

const SCREEN = { width: 1080, height: 2400 };

/**
 * Snapshot-helper XML recorded on the Android emulator (1080x2400,
 * MetaMask Mobile dev build). Texts, labels and most resource ids are
 * blanked; tree, bounds, windows and drawing order are as captured.
 *
 * - wallet home, with the Expo dev-client "Tools" button over the
 * hamburger menu button;
 * - the account list search, with Gboard's floating toolbar shown (the
 * emulator has a hardware keyboard).
 *
 * @param name - The fixture name.
 * @returns The parsed hierarchy.
 */
const fixture = (name: string): UIElement[] =>
  parseAndroidHierarchy(
    readFileSync(
      new URL(
        `../backends/__fixtures__/adb-helper-${name}.xml`,
        import.meta.url,
      ),
      'utf8',
    ),
  );

/**
 * Run the hit test at the element's visible center.
 *
 * @param element - The element to tap.
 * @returns The error thrown, or undefined when the tap may go ahead.
 */
const check = (element: UIElement): TargetObscuredError | undefined => {
  try {
    assertAndroidHittable(element, visibleCenter(element, SCREEN), SCREEN);
    return undefined;
  } catch (error) {
    if (error instanceof TargetObscuredError) {
      return error;
    }
    throw error;
  }
};

const byId = (hierarchy: UIElement[], identifier: string): UIElement => {
  const element = findElement(hierarchy, { identifier }, true);
  if (!element) {
    throw new Error(`no ${identifier} in the fixture`);
  }
  return element;
};

const node = (attrs: string, children = ''): string =>
  children ? `<node ${attrs}>${children}</node>` : `<node ${attrs} />`;

const xml = (...windows: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0">${windows.join('')}</hierarchy>`;

const APP_WINDOW =
  'window-index="1" window-type="1" window-layer="0" window-bounds="[0,0][1080,2400]"';

describe('assertAndroidHittable (recorded helper XML)', () => {
  const home = fixture('wallet-home');
  const search = fixture('search-keyboard');

  it('refuses the hamburger button under the Expo "Tools" button', () => {
    const error = check(byId(home, 'navbar-hamburger-menu-button'));

    expect(error).toBeInstanceOf(TargetObscuredError);
    expect(error).toMatchObject({ code: 'TARGET_OBSCURED', keyboard: false });
    expect(error?.message).toContain(
      'id="navbar-hamburger-menu-button" is covered at (973, 137) by ' +
        'android.view.View around android.widget.ImageView label="Tools"',
    );
    expect(error?.message).toContain('Close the overlay');
  });

  it('refuses a token row under the floating tab bar, naming the tab', () => {
    const error = check(byId(home, 'asset-row-3'));

    expect(error?.message).toContain('by android.view.ViewGroup');
    expect(error?.keyboard).toBe(false);
  });

  it.each([
    'tab-bar-item-Wallet',
    'tab-bar-item-Trending',
    'tab-bar-floating-trade-button',
    'account-picker',
    'wallet-send-button',
    'wallet-receive-button',
    'wallet-search-button',
    'homepage-section-title-tokens',
    'asset-row-1',
  ])('lets a tap on the free %s through (wallet home)', (identifier) => {
    expect(check(byId(home, identifier))).toBeUndefined();
  });

  it.each([
    'multichain-account-selector-search-input',
    'back-arrow-button',
    'account-list-add-account-button',
    'button-icon',
  ])('lets a tap on the free %s through (keyboard up)', (identifier) => {
    expect(check(byId(search, identifier))).toBeUndefined();
  });

  it('refuses a point under the keyboard, naming the keyboard', () => {
    const input = byId(search, 'multichain-account-selector-search-input');
    // Gboard's floating toolbar key at [108,151][211,248] is above the app.
    let error: unknown;
    try {
      assertAndroidHittable(input, { x: 150, y: 240 }, SCREEN);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TargetObscuredError);
    expect(error).toMatchObject({ keyboard: true, x: 150, y: 240 });
    expect((error as Error).message).toContain(
      'is covered at (150, 240) by the keyboard: android.widget.FrameLayout. ',
    );
    expect((error as Error).message).toContain(
      'Dismiss the keyboard (device_dismiss_keyboard)',
    );
  });

  it('ignores the keyboard window outside its drawn nodes', () => {
    // The IME window's bounds cover y 137..2400, but nothing is drawn here.
    const input = byId(search, 'multichain-account-selector-search-input');

    expect(() =>
      assertAndroidHittable(input, { x: 540, y: 300 }, SCREEN),
    ).not.toThrow();
  });
});

describe('assertAndroidHittable (rules)', () => {
  const target =
    'resource-id="target" class="android.widget.Button" clickable="true" visible-to-user="true" bounds="[100,100][300,200]"';

  const appWindow = (...children: string[]): string =>
    node(
      `${APP_WINDOW} class="android.widget.FrameLayout" visible-to-user="true" drawing-order="0" bounds="[0,0][1080,2400]"`,
      children.join(''),
    );

  const targetIn = (hierarchy: UIElement[]): UIElement =>
    byId(hierarchy, 'target');

  it('refuses a sibling drawn after the target', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            'resource-id="sheet" class="android.view.ViewGroup" content-desc="Sheet" visible-to-user="true" drawing-order="2" bounds="[0,150][1080,900]"',
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))?.message).toContain('id="sheet"');
  });

  it('ignores a sibling drawn before the target', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(
            'resource-id="under" class="android.view.ViewGroup" content-desc="Under" visible-to-user="true" drawing-order="1" bounds="[0,0][1080,900]"',
          ),
          node(`${target} drawing-order="2"`),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeUndefined();
  });

  it('ignores an overlay that is not visible to the user', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            'class="android.view.View" content-desc="Fade" visible-to-user="false" drawing-order="2" bounds="[0,0][1080,300]"',
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeUndefined();
  });

  it('ignores a full-width wrapper, but not its drawn children', () => {
    const wrapper = (child: string): UIElement[] =>
      parseAndroidHierarchy(
        xml(
          appWindow(
            node(`${target} drawing-order="1"`),
            node(
              'class="android.view.ViewGroup" visible-to-user="true" drawing-order="2" bounds="[0,120][1080,400]"',
              child,
            ),
          ),
        ),
      );

    expect(
      check(
        targetIn(
          wrapper(
            node(
              'class="android.widget.Button" content-desc="Far" clickable="true" visible-to-user="true" drawing-order="1" bounds="[600,120][800,400]"',
            ),
          ),
        ),
      ),
    ).toBeUndefined();
    expect(
      check(
        targetIn(
          wrapper(
            node(
              'class="android.widget.Button" content-desc="Over" clickable="true" visible-to-user="true" drawing-order="1" bounds="[150,120][250,400]"',
            ),
          ),
        ),
      )?.message,
    ).toContain('label="Over"');
  });

  it('accepts a later-drawn sibling inside the target (trade-off)', () => {
    // Its own icon drawn as a sibling, or an overlay that fits inside the
    // target: they can't be told apart, so both go through.
    const overlay = (bounds: string): UIElement[] =>
      parseAndroidHierarchy(
        xml(
          appWindow(
            node(`${target} drawing-order="1"`),
            node(
              `class="android.widget.ImageView" visible-to-user="true" drawing-order="2" bounds="${bounds}"`,
            ),
          ),
        ),
      );

    expect(check(targetIn(overlay('[150,120][250,180]')))).toBeUndefined();
    expect(check(targetIn(overlay('[100,100][300,200]')))).toBeUndefined();
  });

  it('ignores a box-none container around a floating button', () => {
    // An RN `box-none` host: a wrapper much larger than what it draws.
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            'class="android.view.ViewGroup" visible-to-user="true" drawing-order="2" bounds="[42,63][1038,2400]"',
            node(
              'resource-id="fab" class="android.widget.Button" content-desc="Add" clickable="true" visible-to-user="true" drawing-order="1" bounds="[870,2100][1000,2230]"',
            ),
          ),
        ),
      ),
    );

    expect(() =>
      assertAndroidHittable(targetIn(hierarchy), { x: 200, y: 150 }, SCREEN),
    ).not.toThrow();
  });

  it('refuses a close wrapper around a drawn node (an overlay button)', () => {
    // As the Expo "Tools" button: a 137 px background around a 68 px icon.
    const overlay = (bounds: string, icon: string): UIElement[] =>
      parseAndroidHierarchy(
        xml(
          appWindow(
            node(`${target} drawing-order="1"`),
            node(
              `class="android.view.View" visible-to-user="true" drawing-order="2" bounds="${bounds}"`,
              node(
                `class="android.widget.ImageView" content-desc="Tools" visible-to-user="true" drawing-order="1" bounds="${icon}"`,
              ),
            ),
          ),
        ),
      );

    expect(
      check(targetIn(overlay('[150,80][287,217]', '[184,114][252,182]')))
        ?.message,
    ).toContain('android.view.View around android.widget.ImageView');
    // Larger than the small-size rule, but at most twice its drawn content
    // (400x400 around 350x230); the tap point is on the wrapper only.
    expect(
      check(targetIn(overlay('[60,60][460,460]', '[90,210][440,440]')))
        ?.message,
    ).toContain('android.view.View around android.widget.ImageView');
    // Just over twice its drawn content: a transparent container.
    expect(
      check(targetIn(overlay('[60,60][460,460]', '[90,230][440,440]'))),
    ).toBeUndefined();
  });

  it.each([
    ['an inset absolute-fill host', '[0,63][1080,2400]'],
    ['a full-width layer', '[0,50][1080,400]'],
    ['a layer over half the window', '[0,0][800,1700]'],
  ])('ignores a large unlabelled leaf drawn later: %s', (_name, bounds) => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            `class="android.view.ViewGroup" visible-to-user="true" drawing-order="2" bounds="${bounds}"`,
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeUndefined();
  });

  it.each([
    ['clickable', 'clickable="true"'],
    ['labelled', 'content-desc="Backdrop"'],
    ['with a resource id', 'resource-id="backdrop"'],
  ])('refuses a large leaf drawn later that is %s', (_name, attr) => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            `class="android.view.ViewGroup" ${attr} visible-to-user="true" drawing-order="2" bounds="[0,63][1080,2400]"`,
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeInstanceOf(TargetObscuredError);
  });

  it('refuses a small unlabelled leaf drawn later', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            'class="android.view.View" visible-to-user="true" drawing-order="2" bounds="[150,120][450,400]"',
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeInstanceOf(TargetObscuredError);
  });

  it('refuses a node of a higher system window, not as the keyboard', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        node(
          'window-index="0" window-type="3" window-layer="2" window-bounds="[0,0][1080,400]" class="android.widget.FrameLayout" visible-to-user="true" drawing-order="0" bounds="[0,0][1080,400]"',
          node(
            'resource-id="com.android.systemui:id/heads_up" class="android.widget.FrameLayout" visible-to-user="true" drawing-order="1" bounds="[0,0][1080,300]"',
          ),
        ),
        appWindow(node(`${target} drawing-order="1"`)),
      ),
    );

    const error = check(targetIn(hierarchy));
    expect(error?.message).toContain('com.android.systemui:id/heads_up');
    expect(error?.keyboard).toBe(false);
  });

  it('ignores lower windows', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        node(
          'window-index="0" window-type="1" window-layer="5" window-bounds="[0,0][1080,2400]" class="android.widget.FrameLayout" visible-to-user="true" drawing-order="0" bounds="[0,0][1080,2400]"',
          node(`${target} drawing-order="1"`),
        ),
        node(
          'window-index="1" window-type="1" window-layer="0" window-bounds="[0,0][1080,2400]" class="android.widget.FrameLayout" visible-to-user="true" drawing-order="0" bounds="[0,0][1080,2400]"',
          node(
            'class="android.widget.Button" content-desc="Behind" clickable="true" visible-to-user="true" drawing-order="1" bounds="[0,0][1080,900]"',
          ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeUndefined();
  });

  it('lets every tap through for a stock uiautomator dump', () => {
    // From android15-qpr2 on, the stock dumper writes drawing-order, but
    // never window metadata or visible-to-user: nothing can be told.
    const hierarchy = parseAndroidHierarchy(
      xml(
        node(
          'class="android.widget.FrameLayout" drawing-order="0" bounds="[0,0][1080,2400]"',
          node(
            'resource-id="target" class="android.widget.Button" clickable="true" drawing-order="1" bounds="[100,100][300,200]"',
          ) +
            node(
              'class="android.widget.Button" content-desc="Over" clickable="true" drawing-order="2" bounds="[0,0][1080,900]"',
            ),
        ),
      ),
    );

    expect(check(targetIn(hierarchy))).toBeUndefined();
  });

  it('lets a tap through for a copy of a snapshot element', () => {
    const hierarchy = parseAndroidHierarchy(
      xml(
        appWindow(
          node(`${target} drawing-order="1"`),
          node(
            'resource-id="sheet" class="android.view.ViewGroup" content-desc="Sheet" visible-to-user="true" drawing-order="2" bounds="[0,150][1080,900]"',
          ),
        ),
      ),
    );
    const copy = JSON.parse(JSON.stringify(targetIn(hierarchy))) as UIElement;

    expect(check(targetIn(hierarchy))).toBeInstanceOf(TargetObscuredError);
    expect(check(copy)).toBeUndefined();
  });

  it('lets a tap through for an element that is not from a snapshot', () => {
    expect(
      check({
        type: 'android.widget.Button',
        identifier: 'target',
        frame: { x: 100, y: 100, width: 200, height: 100 },
        enabled: true,
      }),
    ).toBeUndefined();
  });
});
