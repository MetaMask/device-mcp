import { describe, it, expect } from 'vitest';

import { parseIdbHierarchy, mapIdbElement } from './idb-backend.js';

describe('parseIdbHierarchy', () => {
  it('parses a JSON array of elements', () => {
    const raw = JSON.stringify([
      {
        type: 'Button',
        AXLabel: 'Submit',
        frame: { x: 10, y: 20, width: 100, height: 44 },
        enabled: true,
      },
      {
        type: 'TextField',
        AXLabel: 'Password',
        AXValue: '***',
        frame: { x: 10, y: 80, width: 300, height: 44 },
        enabled: true,
      },
    ]);

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('Button');
    expect(result[0].label).toBe('Submit');
    expect(result[1].value).toBe('***');
  });

  it('parses a root object with children', () => {
    const raw = JSON.stringify({
      type: 'Application',
      children: [
        {
          type: 'Window',
          AXLabel: 'Main',
          frame: { x: 0, y: 0, width: 390, height: 844 },
          enabled: true,
        },
      ],
    });

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('Window');
    expect(result[0].label).toBe('Main');
  });

  it('parses a single root element without children', () => {
    const raw = JSON.stringify({
      type: 'StaticText',
      AXLabel: 'Hello',
      frame: { x: 50, y: 100, width: 200, height: 30 },
      enabled: true,
    });

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Hello');
  });

  it('returns raw fallback on invalid JSON', () => {
    const result = parseIdbHierarchy('not-json-at-all');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('raw');
    expect(result[0].label).toBe('not-json-at-all');
  });

  it('handles empty JSON array', () => {
    const result = parseIdbHierarchy('[]');
    expect(result).toStrictEqual([]);
  });

  it('parses nested children recursively', () => {
    const raw = JSON.stringify([
      {
        type: 'Window',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        enabled: true,
        children: [
          {
            type: 'Button',
            AXLabel: 'Nested',
            frame: { x: 10, y: 10, width: 50, height: 30 },
            enabled: true,
          },
        ],
      },
    ]);

    const result = parseIdbHierarchy(raw);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children![0].label).toBe('Nested');
  });
});

describe('mapIdbElement', () => {
  it('prefers AX-prefixed fields over plain fields', () => {
    const node = {
      type: 'Button',
      AXType: 'AXButton',
      label: 'plain',
      AXLabel: 'ax-label',
      value: 'plain-val',
      AXValue: 'ax-val',
      identifier: 'plain-id',
      AXUniqueId: 'ax-id',
      frame: { x: 0, y: 0, width: 100, height: 44 },
      enabled: true,
    };

    const result = mapIdbElement(node);
    expect(result.type).toBe('Button');
    expect(result.label).toBe('ax-label');
    expect(result.value).toBe('ax-val');
    expect(result.identifier).toBe('ax-id');
  });

  it('falls back to plain fields when AX fields are missing', () => {
    const node = {
      type: 'TextField',
      label: 'Email',
      value: 'test@example.com',
      identifier: 'email-input',
      frame: { x: 10, y: 20, width: 300, height: 44 },
      enabled: false,
    };

    const result = mapIdbElement(node);
    expect(result.label).toBe('Email');
    expect(result.value).toBe('test@example.com');
    expect(result.identifier).toBe('email-input');
    expect(result.enabled).toBe(false);
  });

  it('defaults frame to zeros when missing', () => {
    const node = { type: 'Other' };
    const result = mapIdbElement(node);
    expect(result.frame).toStrictEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('defaults type to Unknown when missing', () => {
    const node = { frame: { x: 0, y: 0, width: 10, height: 10 } };
    const result = mapIdbElement(node);
    expect(result.type).toBe('Unknown');
  });
});
