import { describe, it, expect } from 'vitest';

import { parseAndroidHierarchy, parseNodeAttributes } from './adb-backend.js';

const SAMPLE_UIAUTOMATOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="MetaMask" resource-id="io.metamask:id/title" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][500,260]" />
    <node index="1" text="" resource-id="io.metamask:id/identicon" class="android.widget.ImageView" package="io.metamask" content-desc="Account avatar" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,50][980,130]" />
    <node index="2" text="$0.00" resource-id="io.metamask:id/balance" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[200,300][600,360]" />
  </node>
</hierarchy>`;

describe('parseAndroidHierarchy', () => {
  it('parses uiautomator XML into flat element list', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    expect(elements).toHaveLength(4);
  });

  it('extracts text content', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const title = elements.find((element) => element.value === 'MetaMask');
    expect(title).toBeDefined();
    expect(title!.identifier).toBe('io.metamask:id/title');
    expect(title!.type).toBe('android.widget.TextView');
  });

  it('extracts content-desc as label', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const avatar = elements.find(
      (element) => element.label === 'Account avatar',
    );
    expect(avatar).toBeDefined();
    expect(avatar!.identifier).toBe('io.metamask:id/identicon');
  });

  it('parses bounds into frame coordinates', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const title = elements.find((element) => element.value === 'MetaMask');
    expect(title!.frame).toStrictEqual({
      x: 100,
      y: 200,
      width: 400,
      height: 60,
    });
  });

  it('detects disabled elements', () => {
    const elements = parseAndroidHierarchy(SAMPLE_UIAUTOMATOR_XML);
    const balance = elements.find((element) => element.value === '$0.00');
    expect(balance).toBeDefined();
    expect(balance!.enabled).toBe(false);
  });

  it('handles empty XML gracefully', () => {
    const elements = parseAndroidHierarchy('');
    expect(elements).toStrictEqual([]);
  });
});

describe('parseNodeAttributes', () => {
  it('returns null for missing bounds', () => {
    const result = parseNodeAttributes('text="hello" class="View"');
    expect(result).toBeNull();
  });

  it('returns null for malformed bounds', () => {
    const result = parseNodeAttributes(
      'text="hello" class="View" bounds="invalid"',
    );
    expect(result).toBeNull();
  });

  it('parses a complete attribute string', () => {
    const attrs =
      'text="Send" resource-id="btn_send" class="Button" ' +
      'content-desc="Send button" enabled="true" bounds="[10,20][110,70]"';
    const result = parseNodeAttributes(attrs);
    expect(result).toStrictEqual({
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
