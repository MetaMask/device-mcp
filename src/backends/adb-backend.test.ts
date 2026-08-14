/* eslint-disable n/no-process-env -- these tests toggle DEVICE_MCP_ANDROID_SNAPSHOT to exercise the snapshot-strategy opt-in */
import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  parseAndroidHierarchy,
  parseNodeAttributes,
  AdbBackend,
} from './adb-backend.js';
import { findElement } from '../utils/element.js';
import * as execModule from '../utils/exec.js';
import * as signerModule from './android-snapshot-helper/signer.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execStrict: vi.fn(),
  isCommandAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('./android-snapshot-helper/signer.js', async (importActual) => {
  const actual = await importActual<typeof signerModule>();
  return {
    ...actual,
    verifyInstalledAndroidSnapshotHelperSigner: vi
      .fn()
      .mockResolvedValue(undefined),
  };
});

const mockExec = vi.mocked(execModule.exec);
const mockExecStrict = vi.mocked(execModule.execStrict);
const mockReadFile = vi.mocked(readFile);

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

describe('AdbBackend.kind', () => {
  it('is the stable "adb" discriminator', () => {
    expect(new AdbBackend('emulator-5554').kind).toBe('adb');
  });
});

describe('AdbBackend.getElementText', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecStrict.mockResolvedValue('device');
    backend = new AdbBackend('emulator-5554');
  });

  const xmlWithElement = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node text="$42.00" resource-id="io.metamask:id/balance" class="android.widget.TextView" content-desc="Account balance" enabled="true" bounds="[100,200][500,260]" />
</hierarchy>`;

  it('returns label (content-desc) from matching element', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('get-state')) {
        return 'device';
      }
      return xmlWithElement;
    });

    const text = await backend.getElementText({
      identifier: 'io.metamask:id/balance',
    });

    expect(text).toBe('Account balance');
  });

  it('returns value (text attr) when no label', async () => {
    const xmlNoDesc = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy>
  <node text="hello" resource-id="field" class="EditText" content-desc="" enabled="true" bounds="[0,0][100,50]" />
</hierarchy>`;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('get-state')) {
        return 'device';
      }
      return xmlNoDesc;
    });

    const text = await backend.getElementText({ identifier: 'field' });

    expect(text).toBe('hello');
  });

  it('throws when element not found', async () => {
    const emptyXml = `<?xml version="1.0" encoding="UTF-8"?><hierarchy></hierarchy>`;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('get-state')) {
        return 'device';
      }
      return emptyXml;
    });

    await expect(
      backend.getElementText({ identifier: 'missing' }),
    ).rejects.toThrow('Element not found');
  });
});

describe('AdbBackend.screenshot', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new AdbBackend('emulator-5554');
  });

  it('captures with screencap and encodes base64 in-process by default', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('QUJDREVG');

    const result = await backend.screenshot('/tmp/a.png');

    expect(mockExecStrict).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'pull',
      '/sdcard/screenshot.png',
      '/tmp/a.png',
    ]);
    expect(mockReadFile).toHaveBeenCalledWith('/tmp/a.png', 'base64');
    expect(result).toStrictEqual({
      data: 'QUJDREVG',
      format: 'png',
      path: '/tmp/a.png',
    });
  });

  it('never shells out to the non-portable base64 binary', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('Zm9v');

    await backend.screenshot('/tmp/a.png');

    expect(mockExecStrict).not.toHaveBeenCalledWith(
      'base64',
      expect.anything(),
    );
  });

  it('skips base64 encoding when encode is false', async () => {
    mockExecStrict.mockResolvedValue('');

    const result = await backend.screenshot('/tmp/a.png', { encode: false });

    expect(mockReadFile).not.toHaveBeenCalled();
    expect(result).toStrictEqual({
      data: undefined,
      format: 'png',
      path: '/tmp/a.png',
    });
  });

  it('defaults to a tmp path when none is provided', async () => {
    mockExecStrict.mockResolvedValue('');
    mockReadFile.mockResolvedValue('YmFy');

    const result = await backend.screenshot();

    expect(result.path).toMatch(
      /[/\\]device-mcp-[^/\\]+[/\\]screenshot-[0-9a-f]{16}\.png$/u,
    );
    expect(result.data).toBe('YmFy');
  });
});

describe('AdbBackend snapshot strategy', () => {
  const HELPER_XML = `<?xml version="1.0"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" content-desc="" text="" resource-id="" enabled="true" bounds="[0,0][100,100]" />
</hierarchy>`;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEVICE_MCP_ANDROID_SNAPSHOT;
  });

  it('uses raw uiautomator dump by default', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('get-state')) {
        return 'device';
      }
      return HELPER_XML;
    });

    const backend = new AdbBackend('emulator-5554');
    await backend.snapshot();

    expect(mockExecStrict).toHaveBeenCalledWith('adb', [
      '-s',
      'emulator-5554',
      'shell',
      'uiautomator',
      'dump',
      '/sdcard/window_dump.xml',
    ]);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('uses the instrumentation helper when opted in via constructor', async () => {
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args.includes('list') && args.includes('packages')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[2] === 'install' || args[2] === 'uninstall') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const payload = Buffer.from(HELPER_XML, 'utf8').toString('base64');
      const stdout = [
        'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
        'INSTRUMENTATION_STATUS: chunkIndex=0',
        'INSTRUMENTATION_STATUS: chunkCount=1',
        `INSTRUMENTATION_STATUS: payloadBase64=${payload}`,
        'INSTRUMENTATION_STATUS_CODE: 1',
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: ok=true',
        'INSTRUMENTATION_CODE: -1',
      ].join('\n');
      return { stdout, stderr: '', exitCode: 0 };
    });

    const backend = new AdbBackend('emulator-5554', {
      snapshotStrategy: 'helper',
    });
    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy).toHaveLength(1);
    expect(
      mockExec.mock.calls.some(([, args]) => args.includes('instrument')),
    ).toBe(true);
    expect(mockExecStrict).not.toHaveBeenCalledWith(
      'adb',
      expect.arrayContaining(['uiautomator', 'dump']),
    );
  });

  it('ensures the helper once before sequential captures', async () => {
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args.includes('list') && args.includes('packages')) {
        return {
          stdout:
            'package:com.callstack.agentdevice.snapshothelper versionCode:14009',
          stderr: '',
          exitCode: 0,
        };
      }
      const payload = Buffer.from(HELPER_XML, 'utf8').toString('base64');
      const stdout = [
        'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
        'INSTRUMENTATION_STATUS: chunkIndex=0',
        'INSTRUMENTATION_STATUS: chunkCount=1',
        `INSTRUMENTATION_STATUS: payloadBase64=${payload}`,
        'INSTRUMENTATION_STATUS_CODE: 1',
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: ok=true',
        'INSTRUMENTATION_CODE: -1',
      ].join('\n');
      return { stdout, stderr: '', exitCode: 0 };
    });

    const backend = new AdbBackend('emulator-5554', {
      snapshotStrategy: 'helper',
    });
    await backend.snapshot();
    await backend.snapshot();

    expect(
      mockExec.mock.calls.filter(
        ([, args]) =>
          args.includes('cmd') &&
          args.includes('package') &&
          args.includes('list'),
      ),
    ).toHaveLength(1);
    expect(
      mockExec.mock.calls.filter(([, args]) => args.includes('instrument')),
    ).toHaveLength(2);
  });

  it('retries helper installation after an initial failure', async () => {
    let installAttempts = 0;
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args.includes('list') && args.includes('packages')) {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[2] === 'install') {
        installAttempts += 1;
        return {
          stdout: '',
          stderr: installAttempts === 1 ? 'install failed' : '',
          exitCode: installAttempts === 1 ? 1 : 0,
        };
      }
      const payload = Buffer.from(HELPER_XML, 'utf8').toString('base64');
      const stdout = [
        'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
        'INSTRUMENTATION_STATUS: chunkIndex=0',
        'INSTRUMENTATION_STATUS: chunkCount=1',
        `INSTRUMENTATION_STATUS: payloadBase64=${payload}`,
        'INSTRUMENTATION_STATUS_CODE: 1',
        'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
        'INSTRUMENTATION_RESULT: ok=true',
        'INSTRUMENTATION_CODE: -1',
      ].join('\n');
      return { stdout, stderr: '', exitCode: 0 };
    });

    const backend = new AdbBackend('emulator-5554', {
      snapshotStrategy: 'helper',
    });

    await expect(backend.snapshot()).rejects.toThrow(/snapshot helper/u);
    expect(await backend.snapshot()).toMatchObject({
      hierarchy: expect.any(Array),
    });
    expect(installAttempts).toBe(2);
  });

  it('honors the DEVICE_MCP_ANDROID_SNAPSHOT=helper env opt-in', async () => {
    process.env.DEVICE_MCP_ANDROID_SNAPSHOT = 'helper';
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const backend = new AdbBackend('emulator-5554');
    await expect(backend.snapshot()).rejects.toThrow(/snapshot helper/u);

    expect(
      mockExec.mock.calls.some(([, args]) => args.includes('instrument')),
    ).toBe(true);
  });

  it('fails closed without falling back to raw dump when the helper fails', async () => {
    mockExec.mockResolvedValue({
      stdout: 'noise',
      stderr: '',
      exitCode: 1,
    });

    const backend = new AdbBackend('emulator-5554', {
      snapshotStrategy: 'helper',
    });

    await expect(backend.snapshot()).rejects.toThrow(/snapshot helper/u);
    expect(mockExecStrict).not.toHaveBeenCalledWith(
      'adb',
      expect.arrayContaining(['uiautomator', 'dump']),
    );
  });
});
