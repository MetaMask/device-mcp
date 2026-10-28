import { describe, it, expect } from 'vitest';

import * as publicApi from './index.js';

describe('public API surface', () => {
  it('exports the element locator helpers consumers depend on', () => {
    expect(typeof publicApi.generateLocators).toBe('function');
    expect(typeof publicApi.formatLocators).toBe('function');
    expect(typeof publicApi.findElement).toBe('function');
    expect(typeof publicApi.describeElement).toBe('function');
  });

  it('generateLocators produces suggestions from the package root export', () => {
    const locators = publicApi.generateLocators([
      {
        type: 'Button',
        frame: { x: 0, y: 0, width: 100, height: 44 },
        enabled: true,
        identifier: 'submit',
      },
    ]);

    expect(locators).toHaveLength(1);
    expect(locators[0]?.suggestions[0]).toStrictEqual({
      strategy: 'identifier',
      value: 'submit',
      confidence: 'high',
    });
  });

  it('exports the typed idb transport error', () => {
    expect(
      new publicApi.IdbUnavailableError('IDB_HID_UNAVAILABLE', 'u', 'x').code,
    ).toBe('IDB_HID_UNAVAILABLE');
  });
});
