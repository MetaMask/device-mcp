import { describe, it, expect } from 'vitest';

import {
  parseAppiumAndroidHierarchy,
  parseAppiumIosHierarchy,
} from './appium-backend.js';

const SAMPLE_ANDROID_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="MetaMask" resource-id="io.metamask:id/title" class="android.widget.TextView" content-desc="" enabled="true" bounds="[100,200][500,260]" />
  <node index="1" text="" resource-id="io.metamask:id/avatar" class="android.widget.ImageView" content-desc="User avatar" enabled="true" bounds="[900,50][980,130]" />
  <node index="2" text="$0.00" resource-id="" class="android.widget.TextView" content-desc="" enabled="false" bounds="[200,300][600,360]" />
</hierarchy>`;

const SAMPLE_IOS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="MetaMask" label="MetaMask" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="submit-btn" label="Submit" enabled="true" visible="true" x="20" y="700" width="350" height="44" />
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="password-input" label="Password" value="secret" enabled="true" visible="true" x="20" y="200" width="350" height="44" />
    <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="" label="" value="Welcome back" enabled="true" visible="true" x="20" y="100" width="350" height="30" />
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="settings" label="Settings" enabled="false" visible="true" x="350" y="50" width="30" height="30" />
  </XCUIElementTypeApplication>
</AppiumAUT>`;

describe('parseAppiumAndroidHierarchy', () => {
  it('parses Android XML into flat element list', () => {
    const elements = parseAppiumAndroidHierarchy(SAMPLE_ANDROID_XML);
    expect(elements).toHaveLength(3);
  });

  it('extracts text and resource-id', () => {
    const elements = parseAppiumAndroidHierarchy(SAMPLE_ANDROID_XML);
    const title = elements.find((el) => el.value === 'MetaMask');
    expect(title).toBeDefined();
    expect(title!.identifier).toBe('io.metamask:id/title');
  });

  it('extracts content-desc as label', () => {
    const elements = parseAppiumAndroidHierarchy(SAMPLE_ANDROID_XML);
    const avatar = elements.find((el) => el.label === 'User avatar');
    expect(avatar).toBeDefined();
    expect(avatar!.identifier).toBe('io.metamask:id/avatar');
  });

  it('detects disabled elements', () => {
    const elements = parseAppiumAndroidHierarchy(SAMPLE_ANDROID_XML);
    const balance = elements.find((el) => el.value === '$0.00');
    expect(balance!.enabled).toBe(false);
  });

  it('handles empty XML', () => {
    expect(parseAppiumAndroidHierarchy('')).toStrictEqual([]);
  });
});

describe('parseAppiumIosHierarchy', () => {
  it('parses iOS XCUITest XML into flat element list', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    expect(elements).toHaveLength(5);
  });

  it('strips XCUIElementType prefix from type names', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    const button = elements.find((el) => el.label === 'Submit');
    expect(button).toBeDefined();
    expect(button!.type).toBe('Button');
  });

  it('extracts name as identifier', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    const input = elements.find((el) => el.identifier === 'password-input');
    expect(input).toBeDefined();
    expect(input!.label).toBe('Password');
    expect(input!.value).toBe('secret');
  });

  it('parses frame from x/y/width/height attributes', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    const button = elements.find((el) => el.identifier === 'submit-btn');
    expect(button!.frame).toStrictEqual({
      x: 20,
      y: 700,
      width: 350,
      height: 44,
    });
  });

  it('detects disabled elements', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    const settings = elements.find((el) => el.identifier === 'settings');
    expect(settings!.enabled).toBe(false);
  });

  it('treats empty label/name/value as undefined', () => {
    const elements = parseAppiumIosHierarchy(SAMPLE_IOS_XML);
    const staticText = elements.find((el) => el.value === 'Welcome back');
    expect(staticText).toBeDefined();
    expect(staticText!.label).toBeUndefined();
    expect(staticText!.identifier).toBeUndefined();
  });

  it('handles empty XML', () => {
    expect(parseAppiumIosHierarchy('')).toStrictEqual([]);
  });
});
