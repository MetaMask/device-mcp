import { describe, it, expect } from 'vitest';

import {
  findElement,
  matchesQuery,
  describeElement,
  computeSwipeEnd,
  formatHierarchy,
  generateLocators,
  formatLocators,
} from './element.js';
import type { UIElement } from '../backends/types.js';

const makeElement = (overrides: Partial<UIElement> = {}): UIElement => ({
  type: 'Button',
  frame: { x: 0, y: 0, width: 100, height: 44 },
  enabled: true,
  ...overrides,
});

describe('matchesQuery', () => {
  it('matches by identifier', () => {
    const el = makeElement({ identifier: 'my-btn' });
    expect(matchesQuery(el, { identifier: 'my-btn' })).toBe(true);
    expect(matchesQuery(el, { identifier: 'other' })).toBe(false);
  });

  it('matches by label', () => {
    const el = makeElement({ label: 'Submit' });
    expect(matchesQuery(el, { label: 'Submit' })).toBe(true);
  });

  it('matches text against both value and label', () => {
    const el = makeElement({ value: 'Hello', label: 'greeting' });
    expect(matchesQuery(el, { text: 'Hello' })).toBe(true);
    expect(matchesQuery(el, { text: 'greeting' })).toBe(true);
    expect(matchesQuery(el, { text: 'other' })).toBe(false);
  });

  it('requires at least one filter', () => {
    expect(matchesQuery(makeElement(), {})).toBe(false);
  });

  it('aNDs multiple filters', () => {
    const el = makeElement({ identifier: 'btn', label: 'Go' });
    expect(matchesQuery(el, { identifier: 'btn', label: 'Go' })).toBe(true);
    expect(matchesQuery(el, { identifier: 'btn', label: 'Stop' })).toBe(false);
  });

  it('matches case-insensitively', () => {
    const el = makeElement({ label: 'Submit Button' });
    expect(matchesQuery(el, { label: 'submit button' })).toBe(true);
    expect(matchesQuery(el, { label: 'SUBMIT BUTTON' })).toBe(true);
  });

  it('matches partial text (contains)', () => {
    const el = makeElement({ label: 'Confirm Transaction' });
    expect(matchesQuery(el, { label: 'Confirm' })).toBe(true);
    expect(matchesQuery(el, { label: 'Transaction' })).toBe(true);
    expect(matchesQuery(el, { label: 'confirm trans' })).toBe(true);
  });

  it('matches partial identifier', () => {
    const el = makeElement({ identifier: 'io.metamask:id/submit-btn' });
    expect(matchesQuery(el, { identifier: 'submit-btn' })).toBe(true);
  });

  it('does not match when actual is undefined', () => {
    const el = makeElement({});
    expect(matchesQuery(el, { label: 'anything' })).toBe(false);
  });
});

describe('findElement', () => {
  it('finds a top-level element', () => {
    const elements = [
      makeElement({ identifier: 'a' }),
      makeElement({ identifier: 'b' }),
    ];
    const found = findElement(elements, { identifier: 'b' });
    expect(found?.identifier).toBe('b');
  });

  it('finds a nested element', () => {
    const elements = [
      makeElement({
        identifier: 'parent',
        children: [makeElement({ identifier: 'child' })],
      }),
    ];
    const found = findElement(elements, { identifier: 'child' });
    expect(found?.identifier).toBe('child');
  });

  it('returns null when not found', () => {
    expect(findElement([], { identifier: 'x' })).toBeNull();
    expect(
      findElement([makeElement({ identifier: 'a' })], { identifier: 'x' }),
    ).toBeNull();
  });
});

describe('describeElement', () => {
  it('includes all available fields', () => {
    const el = makeElement({
      label: 'Submit',
      identifier: 'btn-submit',
      value: 'Go',
    });
    const desc = describeElement(el);
    expect(desc).toContain('Button');
    expect(desc).toContain('label="Submit"');
    expect(desc).toContain('id="btn-submit"');
    expect(desc).toContain('value="Go"');
  });

  it('omits undefined fields', () => {
    const desc = describeElement(makeElement());
    expect(desc).toBe('Button');
  });
});

describe('computeSwipeEnd', () => {
  it('computes up', () => {
    expect(computeSwipeEnd(100, 500, 'up', 300)).toStrictEqual([100, 200]);
  });

  it('computes down', () => {
    expect(computeSwipeEnd(100, 500, 'down', 300)).toStrictEqual([100, 800]);
  });

  it('computes left', () => {
    expect(computeSwipeEnd(500, 100, 'left', 200)).toStrictEqual([300, 100]);
  });

  it('computes right', () => {
    expect(computeSwipeEnd(500, 100, 'right', 200)).toStrictEqual([700, 100]);
  });
});

describe('formatHierarchy', () => {
  it('formats a flat list', () => {
    const elements = [makeElement({ type: 'Button', label: 'OK' })];
    const output = formatHierarchy(elements, 0);
    expect(output).toContain('[Button]');
    expect(output).toContain('label="OK"');
  });

  it('indents children', () => {
    const elements = [
      makeElement({
        type: 'Window',
        children: [makeElement({ type: 'Button', label: 'Child' })],
      }),
    ];
    const output = formatHierarchy(elements, 0);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/^\[Window\]/u);
    expect(lines[1]).toMatch(/^\s{2}\[Button\]/u);
  });

  it('marks disabled elements', () => {
    const elements = [makeElement({ enabled: false })];
    const output = formatHierarchy(elements, 0);
    expect(output).toContain('DISABLED');
  });
});

describe('generateLocators', () => {
  it('returns a locator for an interactive element', () => {
    const elements = [makeElement({ type: 'Button', identifier: 'submit' })];
    const locators = generateLocators(elements);
    expect(locators).toHaveLength(1);
    expect(locators[0]?.description).toContain('Button');
    expect(locators[0]?.frame).toStrictEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 44,
    });
  });

  it('skips non-interactive elements without an identifier', () => {
    const elements = [makeElement({ type: 'StaticText', label: 'Heading' })];
    expect(generateLocators(elements)).toHaveLength(0);
  });

  it('treats an enabled element with an identifier as interactive', () => {
    const elements = [
      makeElement({ type: 'StaticText', identifier: 'total', enabled: true }),
    ];
    expect(generateLocators(elements)).toHaveLength(1);
  });

  it('matches interactive types by substring (Android class names)', () => {
    const elements = [
      makeElement({ type: 'android.widget.Button', identifier: 'ok' }),
    ];
    expect(generateLocators(elements)).toHaveLength(1);
  });

  it('recurses into children', () => {
    const elements = [
      makeElement({
        type: 'Window',
        children: [makeElement({ type: 'Button', identifier: 'nested' })],
      }),
    ];
    const locators = generateLocators(elements);
    expect(locators).toHaveLength(1);
    expect(locators[0]?.description).toContain('id="nested"');
  });

  it('ranks identifier high, label medium when an identifier is present', () => {
    const elements = [
      makeElement({ type: 'Button', identifier: 'btn', label: 'Submit' }),
    ];
    const [locator] = generateLocators(elements);
    expect(locator?.suggestions[0]).toStrictEqual({
      strategy: 'identifier',
      value: 'btn',
      confidence: 'high',
    });
    expect(locator?.suggestions[1]).toStrictEqual({
      strategy: 'label',
      value: 'Submit',
      confidence: 'medium',
    });
  });

  it('ranks label high when no identifier is present', () => {
    const elements = [makeElement({ type: 'Button', label: 'Submit' })];
    const [locator] = generateLocators(elements);
    expect(locator?.suggestions[0]).toStrictEqual({
      strategy: 'label',
      value: 'Submit',
      confidence: 'high',
    });
  });

  it('adds a low-confidence text suggestion when value differs from label', () => {
    const elements = [
      makeElement({ type: 'Button', label: 'Amount', value: '1.5' }),
    ];
    const [locator] = generateLocators(elements);
    expect(locator?.suggestions).toContainEqual({
      strategy: 'text',
      value: '1.5',
      confidence: 'low',
    });
  });

  it('falls back to a type suggestion when no other signal exists', () => {
    const elements = [makeElement({ type: 'Button' })];
    const [locator] = generateLocators(elements);
    expect(locator?.suggestions).toStrictEqual([
      { strategy: 'type', value: 'Button', confidence: 'low' },
    ]);
  });
});

describe('formatLocators', () => {
  it('returns a message when there are no interactive elements', () => {
    expect(formatLocators([])).toBe('No interactive elements found on screen.');
  });

  it('numbers entries and renders each suggestion with a confidence icon', () => {
    const locators = generateLocators([
      makeElement({ type: 'Button', identifier: 'btn', label: 'Submit' }),
    ]);
    const output = formatLocators(locators);
    expect(output).toContain('1. ');
    expect(output).toContain('*** { identifier: "btn" }');
    expect(output).toContain('** { label: "Submit" }');
  });
});
