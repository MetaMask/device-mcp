import { describe, it, expect } from 'vitest';

import { parseAndroidHierarchy, parseNodeAttributes } from './adb-backend.js';
import { findElement } from '../utils/element.js';

const SAMPLE_UIAUTOMATOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="MetaMask" resource-id="io.metamask:id/title" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][500,260]" />
    <node index="1" text="" resource-id="io.metamask:id/identicon" class="android.widget.ImageView" package="io.metamask" content-desc="Account avatar" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,50][980,130]" />
    <node index="2" text="$0.00" resource-id="io.metamask:id/balance" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[200,300][600,360]" />
  </node>
</hierarchy>`;

describe('parseAndroidHierarchy', () => {
  it('builds a tree with parent-child relationships', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    expect(elements).toHaveLength(1);
    expect(elements[0].type).toBe('android.widget.FrameLayout');
    expect(elements[0].children).toHaveLength(3);
  });

  it('nests children under the correct parent', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const frame = elements[0];
    expect(frame.children![0].value).toBe('MetaMask');
    expect(frame.children![1].label).toBe('Account avatar');
    expect(frame.children![2].value).toBe('$0.00');
  });

  it('self-closing nodes have no children array', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const title = elements[0].children![0];
    expect(title.children).toBeUndefined();
  });

  it('findElement still finds nested elements', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const title = findElement(elements, { identifier: 'io.metamask:id/title' });
    expect(title).toBeDefined();
    expect(title!.value).toBe('MetaMask');
  });

  it('handles empty XML gracefully', () => {
    expect(parseAndroidHierarchy('')).toStrictEqual([]);
  });

  it('handles deeply nested XML', () => {
    const deepXml = `<hierarchy>
      <node class="Root" bounds="[0,0][100,100]">
        <node class="Mid" bounds="[10,10][90,90]">
          <node class="Leaf" text="deep" bounds="[20,20][80,80]" />
        </node>
      </node>
    </hierarchy>`;
    const elements = parseAndroidHierarchy(deepXml);
    expect(elements).toHaveLength(1);
    expect(elements[0].children).toHaveLength(1);
    expect(elements[0].children![0].children).toHaveLength(1);
    expect(elements[0].children![0].children![0].value).toBe('deep');
  });
});

describe('parseNodeAttributes', () => {
  it('returns null for missing bounds', () => {
    expect(parseNodeAttributes('text="hello" class="View"')).toBeNull();
  });

  it('returns null for malformed bounds', () => {
    expect(
      parseNodeAttributes('text="hello" class="View" bounds="invalid"'),
    ).toBeNull();
  });

  it('parses a complete attribute string', () => {
    const attrs =
      'text="Send" resource-id="btn_send" class="Button" ' +
      'content-desc="Send button" enabled="true" bounds="[10,20][110,70]"';
    expect(parseNodeAttributes(attrs)).toStrictEqual({
      type: 'Button',
      label: 'Send button',
      value: 'Send',
      identifier: 'btn_send',
      frame: { x: 10, y: 20, width: 100, height: 50 },
      enabled: true,
    });
  });

  it('treats empty content-desc and text as undefined', () => {
    const attrs =
      'text="" resource-id="" class="View" content-desc="" ' +
      'enabled="true" bounds="[0,0][100,100]"';
    const result = parseNodeAttributes(attrs);
    expect(result!.label).toBeUndefined();
    expect(result!.value).toBeUndefined();
    expect(result!.identifier).toBeUndefined();
  });
});
