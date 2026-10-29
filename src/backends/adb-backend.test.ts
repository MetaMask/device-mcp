/* eslint-disable n/no-process-env -- these tests toggle DEVICE_MCP_ADB_SNAPSHOT to exercise snapshot-mode selection */
import { readFile, readdir } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseAndroidHierarchy,
  parseNodeAttributes,
  AdbBackend,
} from './adb-backend.js';
import { loadHelperArtifact } from './android-instrumentation/artifact.js';
import {
  HelperNotInstalledError,
  SnapshotHelperError,
  UntrustedHelperError,
} from './android-instrumentation/errors.js';
import {
  assertInstalledHelperTrusted,
  ensureHelperInstalled,
  installHelper,
} from './android-instrumentation/installer.js';
import type { UIElement } from './types.js';
import * as webviewCdpModule from './webview-cdp.js';
import { findElement } from '../utils/element.js';
import * as execModule from '../utils/exec.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execStrict: vi.fn(),
  isCommandAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('./android-instrumentation/installer.js', () => ({
  HelperTrustCache: class {
    forget(): void {
      // The real cache is covered by the installer tests.
    }
  },
  ensureHelperInstalled: vi.fn().mockResolvedValue(undefined),
  assertInstalledHelperTrusted: vi.fn().mockResolvedValue(undefined),
  installHelper: vi.fn().mockResolvedValue(undefined),
  INSTRUMENTATION_NOT_FOUND_SIGNATURE: 'INSTRUMENTATION_FAILED',
}));

vi.mock('./android-instrumentation/artifact.js', () => ({
  loadHelperArtifact: vi.fn(),
}));

vi.mock('./webview-cdp.js', () => ({
  runWebViewCdp: vi.fn(),
}));

const mockExecStrict = vi.mocked(execModule.execStrict);
const mockExec = vi.mocked(execModule.exec);
const mockReadFile = vi.mocked(readFile);
const mockEnsureHelperInstalled = vi.mocked(ensureHelperInstalled);
const mockAssertInstalledHelperTrusted = vi.mocked(
  assertInstalledHelperTrusted,
);
const mockReaddir = vi.mocked(readdir);
const mockInstallHelper = vi.mocked(installHelper);
const mockLoadHelperArtifact = vi.mocked(loadHelperArtifact);
const ARTIFACT_MISSING = new SnapshotHelperError(
  'ARTIFACT_INVALID',
  'Snapshot helper directory is missing',
);
mockLoadHelperArtifact.mockRejectedValue(ARTIFACT_MISSING);
const mockRunWebViewCdp = vi.mocked(webviewCdpModule.runWebViewCdp);

const SAMPLE_UIAUTOMATOR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,1920]">
    <node index="0" text="MetaMask" resource-id="io.metamask:id/title" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][500,260]" />
    <node index="1" text="" resource-id="io.metamask:id/identicon" class="android.widget.ImageView" package="io.metamask" content-desc="Account avatar" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[900,50][980,130]" />
    <node index="2" text="$0.00" resource-id="io.metamask:id/balance" class="android.widget.TextView" package="io.metamask" content-desc="" checkable="false" checked="false" clickable="false" enabled="false" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[200,300][600,360]" />
  </node>
</hierarchy>`;

function assertErr<Res extends { ok: boolean }>(
  value: Res,
): asserts value is Extract<Res, { ok: false }> {
  expect(value.ok).toBe(false);
}

async function withoutRetryDelay<Result>(
  run: () => Promise<Result>,
): Promise<Result> {
  vi.useFakeTimers();
  try {
    // Handle rejection before draining timers to avoid an unhandled rejection.
    const settled = run().then(
      (value) => () => value,
      (error: unknown) => () => {
        throw error;
      },
    );
    await vi.runAllTimersAsync();
    return (await settled)();
  } finally {
    vi.useRealTimers();
  }
}

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

  function depthsById(
    elements: UIElement[],
    depth = 0,
    out: Record<string, number> = {},
  ): Record<string, number> {
    for (const element of elements) {
      if (element.identifier) {
        out[element.identifier] = depth;
      }
      depthsById(element.children ?? [], depth + 1, out);
    }
    return out;
  }

  it('parses a node with negative bounds and keeps its children', () => {
    const xml = `<hierarchy>
      <node resource-id="root" class="Root" bounds="[0,0][1080,2400]">
        <node resource-id="offscreen" class="Pager" bounds="[-1080,0][0,2400]">
          <node resource-id="page" class="Page" bounds="[-1080,100][-10,900]" />
        </node>
        <node resource-id="after" class="View" bounds="[0,0][10,10]" />
      </node>
    </hierarchy>`;

    const elements = parseAndroidHierarchy(xml);

    expect(elements).toHaveLength(1);
    const [root] = elements;
    expect(root.children!.map((child) => child.identifier)).toStrictEqual([
      'offscreen',
      'after',
    ]);
    expect(root.children![0].frame).toStrictEqual({
      x: -1080,
      y: 0,
      width: 1080,
      height: 2400,
    });
    expect(root.children![0].children![0].frame).toStrictEqual({
      x: -1080,
      y: 100,
      width: 1070,
      height: 800,
    });
  });

  it('clamps inverted bounds to a zero width and height', () => {
    const xml = `<hierarchy>
      <node resource-id="below-fold" class="View" bounds="[0,2513][1080,2400]" />
      <node resource-id="negative-x2" class="View" bounds="[84,5570][-647,2400]" />
    </hierarchy>`;

    const [belowFold, negativeX2] = parseAndroidHierarchy(xml);

    expect(belowFold.frame).toStrictEqual({
      x: 0,
      y: 2513,
      width: 1080,
      height: 0,
    });
    expect(negativeX2.frame).toStrictEqual({
      x: 84,
      y: 5570,
      width: 0,
      height: 0,
    });
  });

  it('attaches the children of an unparseable node to its nearest parsed ancestor', () => {
    const xml = `<hierarchy>
      <node resource-id="root" class="Root" bounds="[0,0][100,100]">
        <node resource-id="broken" class="Broken" bounds="not-bounds">
          <node resource-id="orphan-a" class="A" bounds="[0,0][1,1]" />
          <node resource-id="orphan-b" class="B" bounds="[0,0][2,2]">
            <node resource-id="grandchild" class="C" bounds="[0,0][1,1]" />
          </node>
        </node>
        <node resource-id="sibling" class="S" bounds="[0,0][5,5]" />
      </node>
      <node resource-id="second-root" class="Root" bounds="[0,0][100,100]" />
    </hierarchy>`;

    const elements = parseAndroidHierarchy(xml);

    expect(elements.map((element) => element.identifier)).toStrictEqual([
      'root',
      'second-root',
    ]);
    expect(
      elements[0].children!.map((child) => child.identifier),
    ).toStrictEqual(['orphan-a', 'orphan-b', 'sibling']);
    expect(depthsById(elements)).toStrictEqual({
      root: 0,
      'orphan-a': 1,
      'orphan-b': 1,
      grandchild: 2,
      sibling: 1,
      'second-root': 0,
    });
  });

  it('promotes the children of an unparseable top-level node to roots', () => {
    const xml = `<hierarchy>
      <node class="NoBounds">
        <node resource-id="a" class="A" bounds="[0,0][1,1]" />
      </node>
      <node resource-id="b" class="B" bounds="[0,0][1,1]" />
    </hierarchy>`;

    const elements = parseAndroidHierarchy(xml);

    expect(elements.map((element) => element.identifier)).toStrictEqual([
      'a',
      'b',
    ]);
  });

  it('balances consecutive invalid parents without shifting later siblings', () => {
    const xml = `<hierarchy>
      <node resource-id="root" bounds="[0,0][100,100]">
        <node><node bounds="invalid">
          <node resource-id="promoted" bounds="[0,0][1,1]" />
        </node></node>
        <node resource-id="sibling" bounds="[0,0][1,1]" />
      </node>
      <node resource-id="other-root" bounds="[0,0][1,1]" />
    </hierarchy>`;

    expect(depthsById(parseAndroidHierarchy(xml))).toStrictEqual({
      root: 0,
      promoted: 1,
      sibling: 1,
      'other-root': 0,
    });
  });

  it('keeps the window roots of a busy screen with negative and inverted bounds', () => {
    const xml = `<hierarchy rotation="0">
      <node resource-id="status-bar" bounds="[0,0][1080,63]">
        <node resource-id="clock" text="10:52" bounds="[42,0][130,63]" />
      </node>
      <node resource-id="app-root" bounds="[0,0][1080,2400]">
        <node resource-id="carousel" bounds="[0,400][1080,700]">
          <node resource-id="previous-page" bounds="[84,5570][-647,2400]">
            <node resource-id="card" text="Earn" bounds="[-600,450][-100,650]" />
          </node>
          <node resource-id="current-page" bounds="[0,400][1080,700]" />
        </node>
        <node resource-id="token-list" bounds="[0,700][1080,2400]">
          <node resource-id="below-fold" bounds="[0,2513][1080,2400]" />
        </node>
        <node resource-id="tab-bar" bounds="[0,2274][1080,2400]" />
      </node>
    </hierarchy>`;

    const elements = parseAndroidHierarchy(xml);

    expect(elements).toHaveLength(2);
    expect(depthsById(elements)).toStrictEqual({
      'status-bar': 0,
      clock: 1,
      'app-root': 0,
      carousel: 1,
      'previous-page': 2,
      card: 3,
      'current-page': 2,
      'token-list': 1,
      'below-fold': 2,
      'tab-bar': 1,
    });
    const rows = findElement(elements, { identifier: 'below-fold' });
    expect(rows!.frame.height).toBe(0);
    const prev = findElement(elements, { identifier: 'previous-page' });
    expect(prev!.frame).toStrictEqual({ x: 84, y: 5570, width: 0, height: 0 });
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

describe('AdbBackend.snapshot', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    // These tests exercise the stock `uiautomator dump` retry loop in
    // isolation; force that path so the instrumentation helper does not run.
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'dump';
    backend = new AdbBackend('emulator-5554');
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
    delete process.env.DEVICE_MCP_ADB_SNAPSHOT;
    // Implementations set here would otherwise leak into later suites, which stub
    // only execStrict and would then inherit this suite's exec behaviour.
    mockExec.mockReset();
    mockExecStrict.mockReset();
  });

  /**
   * Drive the dump/cat sequence, returning a queued payload per `cat` call.
   *
   * @param catResults - The stdout each successive `cat` should produce.
   * @returns The remote paths passed to `uiautomator dump`.
   */
  function stubDumps(catResults: string[]): string[] {
    const dumpPaths: string[] = [];
    let catIndex = 0;

    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('cat')) {
        const result = catResults[catIndex] ?? '';
        catIndex += 1;
        return result;
      }
      return '';
    });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args?.includes('dump')) {
        dumpPaths.push(args[args.length - 1]);
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    return dumpPaths;
  }

  it('never returns a stale hierarchy: dumps to a unique remote path each attempt', async () => {
    const dumpPaths = stubDumps([
      '',
      '',
      '<hierarchy><node class="T" bounds="[0,0][1,1]" /></hierarchy>',
    ]);

    await withoutRetryDelay(async () => backend.snapshot());

    expect(dumpPaths).toHaveLength(3);
    expect(new Set(dumpPaths).size).toBe(3);
    for (const path of dumpPaths) {
      expect(path).toMatch(
        /^\/data\/local\/tmp\/device-mcp-dump-[0-9a-f-]{36}\.xml$/u,
      );
    }
  });

  it('removes the remote dump file even when the read fails', async () => {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('cat')) {
        throw new Error('cat: No such file or directory');
      }
      return '';
    });

    await expect(
      withoutRetryDelay(async () => backend.snapshot()),
    ).rejects.toThrow('Failed to capture the UI hierarchy');

    const removed = mockExecStrict.mock.calls.filter((call) =>
      call[1]?.includes('rm'),
    );
    expect(removed).toHaveLength(3);
  });

  it('retries and succeeds when an early dump yields no hierarchy', async () => {
    stubDumps([
      '',
      '<hierarchy><node class="android.widget.TextView" text="ok" bounds="[0,0][10,10]" /></hierarchy>',
    ]);

    const snapshot = await withoutRetryDelay(async () => backend.snapshot());

    expect(snapshot.hierarchy).toHaveLength(1);
    expect(snapshot.hierarchy[0].value).toBe('ok');
  });

  it('surfaces the idle-state error with remediation guidance after every retry', async () => {
    mockExecStrict.mockResolvedValue('');
    mockExec.mockResolvedValue({
      stdout: 'UI hierchary dumped to: /data/local/tmp/x.xml',
      stderr: 'ERROR: could not get idle state.',
      exitCode: 0,
    });

    await expect(
      withoutRetryDelay(async () => backend.snapshot()),
    ).rejects.toThrow(/could not get idle state[\s\S]*window_animation_scale/u);
  });

  it('reports an unreachable device instead of blaming animations', async () => {
    mockExecStrict.mockRejectedValue(
      new Error("adb: device 'emulator-5554' not found"),
    );

    await expect(
      withoutRetryDelay(async () => backend.snapshot()),
    ).rejects.toThrow(/device was unreachable/u);
    await expect(
      withoutRetryDelay(async () => backend.snapshot()),
    ).rejects.not.toThrow(/window_animation_scale/u);
  });

  it('accepts an empty-but-valid hierarchy instead of treating it as a failure', async () => {
    stubDumps(['<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>']);

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy).toStrictEqual([]);
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('rejects a truncated dump that only has the opening root tag', async () => {
    const truncated =
      '<?xml version="1.0"?><hierarchy rotation="0"><node class="android.widget.TextView" bounds="[0,0][10,10]"';
    stubDumps([truncated, truncated, truncated]);

    await expect(
      withoutRetryDelay(async () => backend.snapshot()),
    ).rejects.toThrow('Failed to capture the UI hierarchy');
  });

  it('retries a truncated dump and returns the first complete payload', async () => {
    stubDumps([
      '<?xml version="1.0"?><hierarchy rotation="0"><node class="T" bounds="[0,0][1,1]"',
      '<hierarchy><node class="android.widget.TextView" text="whole" bounds="[0,0][10,10]" /></hierarchy>',
    ]);

    const snapshot = await withoutRetryDelay(async () => backend.snapshot());

    expect(snapshot.hierarchy[0].value).toBe('whole');
  });

  it('bounds each attempt by the remaining overall deadline', async () => {
    stubDumps([
      '<hierarchy><node class="T" bounds="[0,0][1,1]" /></hierarchy>',
    ]);

    await backend.snapshot();

    const [, , options] = mockExec.mock.calls[0];
    expect(options?.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  it('stops attempting once the overall deadline is exhausted', async () => {
    vi.useFakeTimers();
    try {
      mockExecStrict.mockResolvedValue('');
      // Each attempt burns 20s of the 25s budget, so only one retry can start.
      mockExec.mockImplementation(async () => {
        vi.advanceTimersByTime(20_000);
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      const pending = backend.snapshot().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      const error = await pending;

      expect(String(error)).toMatch(/budget exhausted/u);
      expect(mockExec.mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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
      expect.stringMatching(
        /^\/data\/local\/tmp\/device-mcp-screenshot-[0-9a-f-]{36}\.png$/u,
      ),
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

function buildInstrumentStdout(xml: string): string {
  return [
    'INSTRUMENTATION_STATUS: chunkCount=1',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml).toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 2',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_CODE: -1',
  ].join('\r\n');
}

const INSTRUMENT_XML =
  `<?xml version='1.0'?><hierarchy rotation="0">` +
  `<node index="0" bounds="[0,0][1080,2274]" class="android.view.View" ` +
  `package="io.metamask" resource-id="tab-bar-item-Wallet" text="Wallet" />` +
  `</hierarchy>`;

describe('AdbBackend.snapshot snapshot-mode selection', () => {
  let backend: AdbBackend;

  const IDLE_DUMP_XML =
    '<hierarchy><node class="T" text="idle" bounds="[0,0][1,1]" /></hierarchy>';

  const FAILED_INSTRUMENT_STDOUT =
    'INSTRUMENTATION_RESULT: ok=false\r\nINSTRUMENTATION_CODE: 0';

  const countExecCalls = (token: string): number =>
    mockExec.mock.calls.filter((call) => call[1]?.includes(token)).length;

  beforeEach(() => {
    vi.resetAllMocks();
    backend = new AdbBackend('emulator-5554');
    mockEnsureHelperInstalled.mockResolvedValue(undefined);
    mockAssertInstalledHelperTrusted.mockResolvedValue(undefined);
    mockLoadHelperArtifact.mockRejectedValue(ARTIFACT_MISSING);
    routeExec();
  });

  afterEach(() => {
    delete process.env.DEVICE_MCP_ADB_SNAPSHOT;
    mockExec.mockReset();
    mockExecStrict.mockReset();
    mockReaddir.mockReset();
    mockAssertInstalledHelperTrusted.mockReset();
    mockEnsureHelperInstalled.mockReset();
  });

  function routeExec(
    overrides: {
      dumpCat?: string;
      instrumentStdout?: string | string[];
    } = {},
  ): void {
    let instrumentIndex = 0;
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('cat')) {
        return overrides.dumpCat ?? '';
      }
      return '';
    });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args?.includes('instrument')) {
        const output =
          overrides.instrumentStdout ?? buildInstrumentStdout(INSTRUMENT_XML);
        const stdout = Array.isArray(output)
          ? output[Math.min(instrumentIndex, output.length - 1)]
          : output;
        instrumentIndex += 1;
        return {
          stdout,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  }

  it('auto: returns the quick dump when the screen is idle', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
    routeExec({
      dumpCat: IDLE_DUMP_XML,
    });

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].value).toBe('idle');
    expect(
      mockExec.mock.calls.some((call) => call[1]?.includes('instrument')),
    ).toBe(false);
  });

  it('auto: falls back to instrumentation when the dump never idles', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
    expect(
      mockExec.mock.calls.some((call) => call[1]?.includes('instrument')),
    ).toBe(true);
  });

  it('auto: ensures a trusted helper before instrumenting', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';

    await backend.snapshot();

    expect(mockEnsureHelperInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledWith(
      'emulator-5554',
      expect.any(Object),
    );
  });

  it('instrument: uses only the helper and never dumps', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
    expect(mockExec.mock.calls.some((call) => call[1]?.includes('dump'))).toBe(
      false,
    );
  });

  it('instrument: surfaces a composed failure when the helper fails', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    routeExec({ instrumentStdout: FAILED_INSTRUMENT_STDOUT });

    await expect(backend.snapshot()).rejects.toThrow(
      /Failed to capture the UI hierarchy[\s\S]*instrument:/u,
    );
    expect(countExecCalls('instrument')).toBe(1);
    expect(countExecCalls('uiautomator')).toBe(0);
  });

  it('caches the install but re-verifies the signer on every snapshot', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';

    await backend.snapshot();
    await backend.snapshot();

    expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(1);
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the installed signer changes after an earlier trusted snapshot', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';

    const first = await backend.snapshot();
    expect(first.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');

    // Replace the installed helper without invalidating the install cache.
    mockAssertInstalledHelperTrusted.mockRejectedValueOnce(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'aaaa',
        actualSignerSha256: 'bbbb',
      }),
    );

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
    expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(1);
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
    expect(
      mockExec.mock.calls.some((call) => call[1]?.includes('uiautomator')),
    ).toBe(false);
  });

  it('auto: fails closed on a trust error and never falls back to dump', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'aaaa',
        actualSignerSha256: 'bbbb',
      }),
    );

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
    expect(countExecCalls('uiautomator')).toBe(1);
    expect(countExecCalls('instrument')).toBe(0);
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(1);
  });

  it('instrument: propagates a trust error unchanged', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'aaaa',
      }),
    );

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
  });

  describe('default mode', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('is helper-first when the bundled helper is available: no quick dump', async () => {
      mockLoadHelperArtifact.mockResolvedValue(
        {} as Awaited<ReturnType<typeof loadHelperArtifact>>,
      );
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });

      const snapshot = await backend.snapshot();

      expect(snapshot.source).toBe('instrument');
      expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
      expect(countExecCalls('uiautomator')).toBe(0);
      expect(console.error).not.toHaveBeenCalled();
    });

    it('uses dump when the helper is missing and warns once on stderr', async () => {
      routeExec({ dumpCat: IDLE_DUMP_XML });

      const first = await backend.snapshot();
      const second = await backend.snapshot();

      expect(first.source).toBe('dump');
      expect(second.source).toBe('dump');
      expect(countExecCalls('instrument')).toBe(0);
      expect(mockEnsureHelperInstalled).not.toHaveBeenCalled();
      expect(mockLoadHelperArtifact).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          `snapshot helper is unavailable (${ARTIFACT_MISSING.message}). Using snapshot mode 'dump'`,
        ),
      );
      expect(console.log).not.toHaveBeenCalled();
    });

    it('does not probe or warn when a mode is explicit', async () => {
      routeExec({ dumpCat: IDLE_DUMP_XML });
      await new AdbBackend('emulator-5554', {
        snapshotMode: 'dump',
      }).snapshot();

      expect(mockLoadHelperArtifact).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it('helper-first: falls back to dump on a non-trust helper failure', async () => {
      mockLoadHelperArtifact.mockResolvedValue(
        {} as Awaited<ReturnType<typeof loadHelperArtifact>>,
      );
      routeExec({
        dumpCat: IDLE_DUMP_XML,
        instrumentStdout: FAILED_INSTRUMENT_STDOUT,
      });

      const snapshot = await backend.snapshot();

      expect(snapshot.source).toBe('dump');
      expect(snapshot.hierarchy[0].value).toBe('idle');
      expect(countExecCalls('instrument')).toBe(1);
      expect(countExecCalls('uiautomator')).toBe(1);
    });

    it('helper-first: fails closed on a trust error and never dumps', async () => {
      mockLoadHelperArtifact.mockResolvedValue(
        {} as Awaited<ReturnType<typeof loadHelperArtifact>>,
      );
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });
      mockAssertInstalledHelperTrusted.mockRejectedValue(
        new UntrustedHelperError('signer mismatch', {
          expectedSignerSha256: 'aaaa',
        }),
      );

      await expect(backend.snapshot()).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
      expect(countExecCalls('uiautomator')).toBe(0);
      expect(countExecCalls('instrument')).toBe(0);
      expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(1);
    });
  });

  describe('mode precedence', () => {
    it('uses the constructor option over the environment variable', async () => {
      process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
      const withOption = new AdbBackend('emulator-5554', {
        snapshotMode: 'dump',
      });
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });

      const snapshot = await withOption.snapshot();

      expect(snapshot.source).toBe('dump');
      expect(countExecCalls('instrument')).toBe(0);
    });

    it('accepts helper-first from the environment variable', async () => {
      process.env.DEVICE_MCP_ADB_SNAPSHOT = 'helper-first';
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });

      const snapshot = await backend.snapshot();

      expect(snapshot.source).toBe('instrument');
      expect(mockLoadHelperArtifact).not.toHaveBeenCalled();
    });

    it('ignores an unknown environment value and uses the default', async () => {
      process.env.DEVICE_MCP_ADB_SNAPSHOT = 'bogus';
      routeExec({ dumpCat: IDLE_DUMP_XML });

      const snapshot = await backend.snapshot();

      expect(snapshot.source).toBe('dump');
      expect(mockLoadHelperArtifact).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown constructor option', () => {
      expect(
        () =>
          new AdbBackend('emulator-5554', {
            snapshotMode: 'bogus' as unknown as 'dump',
          }),
      ).toThrow(/Unknown ADB snapshot mode "bogus"/u);
    });
  });

  describe('auto: sticky quick-dump skip', () => {
    it('skips the quick dump after it lost to the helper', async () => {
      const auto = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });

      const first = await auto.snapshot();
      expect(first.source).toBe('instrument');
      expect(countExecCalls('uiautomator')).toBe(1);

      const second = await auto.snapshot();
      const third = await auto.snapshot();

      expect(second.source).toBe('instrument');
      expect(third.source).toBe('instrument');
      expect(countExecCalls('uiautomator')).toBe(1);
      expect(countExecCalls('instrument')).toBe(3);
    });

    it('is per backend instance', async () => {
      const first = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });
      await first.snapshot();

      const other = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });
      await other.snapshot();

      expect(countExecCalls('uiautomator')).toBe(2);
    });

    it('does not become sticky when the quick dump wins', async () => {
      const auto = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });

      await auto.snapshot();
      await auto.snapshot();

      expect(countExecCalls('uiautomator')).toBe(2);
      expect(countExecCalls('instrument')).toBe(0);
    });

    it('resets when the helper fails and the dump fallback succeeds', async () => {
      const auto = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });
      const device = {
        dumpCat: '',
        instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
      };
      routeExec(device);

      // Quick dump fails; helper wins.
      await auto.snapshot();
      expect(countExecCalls('uiautomator')).toBe(1);

      // Helper fails; dump rescues the capture and clears stickiness.
      device.dumpCat = IDLE_DUMP_XML;
      device.instrumentStdout = FAILED_INSTRUMENT_STDOUT;
      const second = await auto.snapshot();
      expect(second.source).toBe('dump');
      expect(countExecCalls('uiautomator')).toBe(2);
      expect(countExecCalls('instrument')).toBe(2);

      // Quick dump wins again.
      const third = await auto.snapshot();
      expect(third.source).toBe('dump');
      expect(countExecCalls('uiautomator')).toBe(3);
      expect(countExecCalls('instrument')).toBe(2);
    });

    it('stays fail-closed on a trust error while sticky', async () => {
      const auto = new AdbBackend('emulator-5554', { snapshotMode: 'auto' });
      await auto.snapshot();

      mockAssertInstalledHelperTrusted.mockRejectedValueOnce(
        new UntrustedHelperError('signer mismatch', {
          expectedSignerSha256: 'aaaa',
        }),
      );

      await expect(auto.snapshot()).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
      expect(countExecCalls('uiautomator')).toBe(1);
    });
  });

  describe('helper uninstalled mid-session', () => {
    const notInstalled = (): HelperNotInstalledError =>
      new HelperNotInstalledError('Snapshot helper is not installed');

    it.each(['helper-first', 'instrument'] as const)(
      '%s: reinstalls and retries once when pm path finds no helper',
      async (snapshotMode) => {
        const helperBackend = new AdbBackend('emulator-5554', {
          snapshotMode,
        });
        routeExec({
          dumpCat: IDLE_DUMP_XML,
        });

        await helperBackend.snapshot();
        expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(1);

        mockAssertInstalledHelperTrusted.mockRejectedValueOnce(notInstalled());

        const second = await helperBackend.snapshot();

        expect(second.source).toBe('instrument');
        expect(second.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
        expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(2);
        expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(3);
        expect(countExecCalls('uiautomator')).toBe(0);
      },
    );

    it('instrument: reports a composed failure, not a trust error, when the reinstall does not help', async () => {
      const helperBackend = new AdbBackend('emulator-5554', {
        snapshotMode: 'instrument',
      });
      mockAssertInstalledHelperTrusted
        .mockRejectedValueOnce(notInstalled())
        .mockRejectedValueOnce(notInstalled());

      const error = await helperBackend.snapshot().then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(error).not.toBeInstanceOf(UntrustedHelperError);
      expect(String(error)).toMatch(
        /Failed to capture the UI hierarchy[\s\S]*not installed/u,
      );
      expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(2);
      expect(countExecCalls('uiautomator')).toBe(0);
    });

    it('helper-first: falls back to dump when the reinstall does not help', async () => {
      const helperBackend = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });
      mockAssertInstalledHelperTrusted
        .mockRejectedValueOnce(notInstalled())
        .mockRejectedValueOnce(notInstalled());

      const snapshot = await helperBackend.snapshot();

      expect(snapshot.source).toBe('dump');
      expect(countExecCalls('uiautomator')).toBe(1);
    });

    it('helper-first: still fails closed when the reinstalled helper is untrusted', async () => {
      const helperBackend = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      routeExec({
        dumpCat: IDLE_DUMP_XML,
      });
      mockAssertInstalledHelperTrusted
        .mockRejectedValueOnce(notInstalled())
        .mockRejectedValueOnce(
          new UntrustedHelperError('signer mismatch', {
            expectedSignerSha256: 'aaaa',
          }),
        );

      await expect(helperBackend.snapshot()).rejects.toBeInstanceOf(
        UntrustedHelperError,
      );
      expect(countExecCalls('uiautomator')).toBe(0);
    });
  });

  describe('helper incomplete capture', () => {
    const INCOMPLETE_STDOUT = [
      'INSTRUMENTATION_RESULT: errorType=io.metamask.devicemcp.snapshothelper.AccessibilityCaptureStabilizer$IncompleteCaptureException',
      'INSTRUMENTATION_RESULT: message=Capture did not stabilize within 500ms',
      'INSTRUMENTATION_RESULT: ok=false',
      'INSTRUMENTATION_CODE: -1',
    ].join('\r\n');

    it.each(['helper-first', 'instrument', 'auto'] as const)(
      '%s: retries the helper after an incomplete capture and succeeds',
      async (snapshotMode) => {
        const target = new AdbBackend('emulator-5554', { snapshotMode });
        routeExec({
          instrumentStdout: [
            INCOMPLETE_STDOUT,
            buildInstrumentStdout(INSTRUMENT_XML),
          ],
        });

        const snapshot = await withoutRetryDelay(async () => target.snapshot());

        expect(snapshot.source).toBe('instrument');
        expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
        expect(countExecCalls('instrument')).toBe(2);
        expect(countExecCalls('uiautomator')).toBe(
          snapshotMode === 'auto' ? 1 : 0,
        );
        expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
      },
    );

    it('helper-first: after 3 incomplete captures, makes one dump attempt only', async () => {
      const target = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      routeExec({ instrumentStdout: INCOMPLETE_STDOUT });

      await expect(
        withoutRetryDelay(async () => target.snapshot()),
      ).rejects.toThrow(
        /Failed to capture the UI hierarchy[\s\S]*Capture did not stabilize[\s\S]*dump attempt 1/u,
      );
      expect(countExecCalls('instrument')).toBe(3);
      expect(countExecCalls('uiautomator')).toBe(1);
    });

    it('helper-first: the single dump attempt can still rescue the snapshot', async () => {
      const target = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      routeExec({
        instrumentStdout: INCOMPLETE_STDOUT,
        dumpCat: IDLE_DUMP_XML,
      });

      const snapshot = await withoutRetryDelay(async () => target.snapshot());

      expect(snapshot.source).toBe('dump');
      expect(countExecCalls('instrument')).toBe(3);
      expect(countExecCalls('uiautomator')).toBe(1);
    });

    it('helper-first: keeps 3 dump attempts when the helper never ran', async () => {
      const target = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      mockEnsureHelperInstalled.mockRejectedValue(
        new Error('Failed to install snapshot helper APK'),
      );

      await expect(
        withoutRetryDelay(async () => target.snapshot()),
      ).rejects.toThrow(/dump attempt 3/u);
      expect(countExecCalls('instrument')).toBe(0);
      expect(countExecCalls('uiautomator')).toBe(3);
    });

    it('instrument: fails after 3 incomplete captures and never dumps', async () => {
      const target = new AdbBackend('emulator-5554', {
        snapshotMode: 'instrument',
      });
      routeExec({ instrumentStdout: INCOMPLETE_STDOUT });

      await expect(
        withoutRetryDelay(async () => target.snapshot()),
      ).rejects.toThrow(
        /retry 1\/2[\s\S]*retry 2\/2[\s\S]*Capture did not stabilize/u,
      );
      expect(countExecCalls('instrument')).toBe(3);
      expect(countExecCalls('uiautomator')).toBe(0);
    });

    it('fails closed when the signer changes between incomplete-capture retries', async () => {
      const target = new AdbBackend('emulator-5554', {
        snapshotMode: 'helper-first',
      });
      routeExec({ instrumentStdout: INCOMPLETE_STDOUT });
      mockAssertInstalledHelperTrusted
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(
          new UntrustedHelperError('signer mismatch', {
            expectedSignerSha256: 'aaaa',
          }),
        );

      await expect(
        withoutRetryDelay(async () => target.snapshot()),
      ).rejects.toBeInstanceOf(UntrustedHelperError);
      expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
      expect(countExecCalls('instrument')).toBe(1);
      expect(countExecCalls('uiautomator')).toBe(0);
    });
  });

  describe('observability', () => {
    it('reports the source and capture time of an instrument snapshot', async () => {
      process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';

      const snapshot = await backend.snapshot();

      expect(snapshot.source).toBe('instrument');
      expect(typeof snapshot.captureMs).toBe('number');
      expect(snapshot.captureMs).toBeGreaterThanOrEqual(0);
    });

    it('reports the capture time including failed attempts', async () => {
      vi.useFakeTimers();
      try {
        process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
        routeExec({
          dumpCat: '',
          instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
        });
        const routed = mockExec.getMockImplementation()!;
        mockExec.mockImplementation(async (cmd, args, options) => {
          // The quick dump burns 11 s before it fails, like on wallet home.
          if (args?.includes('uiautomator')) {
            vi.advanceTimersByTime(11_000);
          }
          if (args?.includes('instrument')) {
            vi.advanceTimersByTime(2_500);
          }
          return routed(cmd, args, options);
        });

        const snapshot = await backend.snapshot();

        expect(snapshot.source).toBe('instrument');
        expect(snapshot.captureMs).toBe(13_500);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('AdbBackend WebView contexts', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new AdbBackend('emulator-5554');
  });

  afterEach(() => {
    mockExecStrict.mockReset();
    mockRunWebViewCdp.mockReset();
  });

  it('getContexts reports only NATIVE_APP when no webview socket exists', async () => {
    mockExecStrict.mockResolvedValue('Num RefCount ... @some_other_socket');
    expect(await backend.getContexts()).toStrictEqual(['NATIVE_APP']);
  });

  it('getContexts reports WEBVIEW when a webview socket exists', async () => {
    mockExecStrict.mockResolvedValue(
      '0000: 00 00 00 0001 01 1 @webview_devtools_remote_12595',
    );
    expect(await backend.getContexts()).toStrictEqual([
      'NATIVE_APP',
      'WEBVIEW',
    ]);
  });

  it('setContext accepts NATIVE_APP and WEBVIEW, rejects unknown', async () => {
    expect(await backend.setContext('NATIVE_APP')).toBeUndefined();
    expect(await backend.setContext('WEBVIEW')).toBeUndefined();
    await expect(backend.setContext('bogus')).rejects.toThrow(
      'Unknown context',
    );
  });
});

describe('AdbBackend.webviewCdp', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new AdbBackend('emulator-5554');
  });

  afterEach(() => {
    mockExecStrict.mockReset();
    mockRunWebViewCdp.mockReset();
  });

  /**
   * Route the adb runner: return the socket dump for cat /proc/net/unix,
   * pids for pidof, and empty for forward create/remove.
   *
   * @param options - Stub configuration.
   * @param options.sockets - The /proc/net/unix payload to return.
   * @param options.pids - The pidof output to return.
   */
  function routeAdb(options: { sockets: string; pids: string }): void {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('/proc/net/unix')) {
        return options.sockets;
      }
      if (args?.includes('pidof')) {
        return options.pids;
      }
      return '';
    });
  }

  it('forwards, runs the CDP command, and removes the forward', async () => {
    routeAdb({
      sockets: '0000: x @webview_devtools_remote_12595',
      pids: '12595',
    });
    mockRunWebViewCdp.mockResolvedValue({ ok: true, result: { value: 1 } });

    const outcome = await backend.webviewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
    });

    expect(outcome).toStrictEqual({ ok: true, result: { value: 1 } });
    const forwardCall = mockExecStrict.mock.calls.find((call) =>
      call[1]?.includes('localabstract:webview_devtools_remote_12595'),
    );
    expect(forwardCall).toBeDefined();
    const removeCall = mockExecStrict.mock.calls.find((call) =>
      call[1]?.includes('--remove'),
    );
    expect(removeCall).toBeDefined();
  });

  it('surfaces the sole-unowned-socket warning via stderr', async () => {
    routeAdb({
      sockets: '0000: x @webview_devtools_remote_999',
      pids: '111 222',
    });
    mockRunWebViewCdp.mockResolvedValue({ ok: true, result: { value: 1 } });
    const warnSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const outcome = await backend.webviewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
    });

    expect(outcome).toStrictEqual({ ok: true, result: { value: 1 } });
    const warned = warnSpy.mock.calls.some(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('webview_cdp:') &&
        call[0].includes('111, 222'),
    );
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it('removes the forward even when the CDP command throws', async () => {
    routeAdb({
      sockets: '0000: x @webview_devtools_remote_12595',
      pids: '12595',
    });
    mockRunWebViewCdp.mockRejectedValue(new Error('ws boom'));

    await expect(
      backend.webviewCdp({ method: 'Runtime.evaluate', timeoutMs: 5000 }),
    ).rejects.toThrow('ws boom');
    expect(
      mockExecStrict.mock.calls.some((call) => call[1]?.includes('--remove')),
    ).toBe(true);
  });

  it('returns WEBVIEW_SOCKET_NOT_FOUND when no socket is published', async () => {
    routeAdb({ sockets: '0000: x @other_socket', pids: '' });

    const outcome = await backend.webviewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
    });

    assertErr(outcome);
    expect(outcome.code).toBe('WEBVIEW_SOCKET_NOT_FOUND');
    expect(mockRunWebViewCdp).not.toHaveBeenCalled();
  });

  it('returns WEBVIEW_SOCKET_AMBIGUOUS for multiple unowned sockets', async () => {
    routeAdb({
      sockets:
        '0000: x @webview_devtools_remote_111\n0001: y @webview_devtools_remote_222',
      pids: '',
    });

    const outcome = await backend.webviewCdp({
      method: 'Runtime.evaluate',
      timeoutMs: 5000,
    });

    assertErr(outcome);
    expect(outcome.code).toBe('WEBVIEW_SOCKET_AMBIGUOUS');
  });
});

describe('AdbBackend clipboard', () => {
  const CLIPBOARD_RUNNER =
    'io.metamask.devicemcp.snapshothelper/.ClipboardInstrumentation';
  const SECRET = 'umbrella review narrow orphan fork extra';

  // `null` models a helper manifest built before clipboard support.
  const artifact = (
    clipboardInstrumentationRunner: string | null = CLIPBOARD_RUNNER,
  ): Awaited<ReturnType<typeof loadHelperArtifact>> => ({
    version: '0.5.1',
    versionCode: 5001,
    packageName: 'io.metamask.devicemcp.snapshothelper',
    instrumentationRunner:
      'io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation',
    ...(clipboardInstrumentationRunner === null
      ? {}
      : { clipboardInstrumentationRunner }),
    apkPath: '/tmp/helper.apk',
    sha256: 'a'.repeat(64),
    signerSha256: 'b'.repeat(64),
    minSdk: 23,
  });

  const okStdout = (length: number): string =>
    `INSTRUMENTATION_RESULT: ok=true\r\nINSTRUMENTATION_RESULT: length=${length}\r\nINSTRUMENTATION_CODE: -1\r\n`;

  const clipboardCalls = (): string[][] =>
    mockExec.mock.calls
      .map((call) => call[1] ?? [])
      .filter((args) => args.includes(CLIPBOARD_RUNNER));

  let backend: AdbBackend;

  beforeEach(() => {
    vi.resetAllMocks();
    backend = new AdbBackend('emulator-5554');
    mockLoadHelperArtifact.mockResolvedValue(artifact());
    mockEnsureHelperInstalled.mockResolvedValue(undefined);
    mockAssertInstalledHelperTrusted.mockResolvedValue(undefined);
    mockInstallHelper.mockResolvedValue(undefined);
    mockExec.mockResolvedValue({
      stdout: okStdout(SECRET.length),
      stderr: '',
      exitCode: 0,
    });
  });

  it('writes the text through the clipboard instrumentation', async () => {
    await backend.setClipboard(SECRET);

    const calls = clipboardCalls();
    expect(calls).toHaveLength(1);
    const [args] = calls;
    expect(args.slice(0, 2)).toStrictEqual(['-s', 'emulator-5554']);
    const encoded = args[args.indexOf('textB64') + 1];
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(SECRET);
  });

  it('installs and trust-checks the helper before writing', async () => {
    await backend.setClipboard(SECRET);

    expect(mockEnsureHelperInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(1);
    const trustOrder =
      mockAssertInstalledHelperTrusted.mock.invocationCallOrder[0];
    const execOrder = mockExec.mock.invocationCallOrder[0];
    expect(trustOrder).toBeLessThan(execOrder);
  });

  it('never writes through an untrusted helper', async () => {
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'b'.repeat(64),
      }),
    );

    await expect(backend.setClipboard(SECRET)).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
    expect(clipboardCalls()).toHaveLength(0);
  });

  it('never passes the plain text to adb', async () => {
    await backend.setClipboard(SECRET);

    for (const call of mockExec.mock.calls) {
      expect((call[1] ?? []).join(' ')).not.toContain('umbrella');
    }
  });

  // Matches a real device: `am` prints the missing runner on stderr, exit 1.
  const missingRunner = {
    stdout:
      'INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info\r\nINSTRUMENTATION_STATUS_CODE: -1\r\n',
    stderr: `android.util.AndroidException: INSTRUMENTATION_FAILED: ${CLIPBOARD_RUNNER}\n`,
    exitCode: 1,
  };

  it('reinstalls once when the installed helper lacks the clipboard runner', async () => {
    mockExec.mockResolvedValueOnce(missingRunner).mockResolvedValueOnce({
      stdout: okStdout(SECRET.length),
      stderr: '',
      exitCode: 0,
    });

    await backend.setClipboard(SECRET);

    expect(mockInstallHelper).toHaveBeenCalledTimes(1);
    expect(clipboardCalls()).toHaveLength(2);
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
  });

  it('fails when the reinstalled helper still lacks the runner', async () => {
    mockExec.mockResolvedValue(missingRunner);

    await expect(backend.setClipboard(SECRET)).rejects.toThrow(
      /no result record/u,
    );
    expect(mockInstallHelper).toHaveBeenCalledTimes(1);
  });

  it('reinstalls when the helper was removed after it was installed', async () => {
    await backend.setClipboard(SECRET);
    expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(1);

    mockAssertInstalledHelperTrusted.mockRejectedValueOnce(
      new HelperNotInstalledError('Snapshot helper is not installed'),
    );

    await backend.setClipboard(SECRET);

    expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(2);
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(3);
    expect(clipboardCalls()).toHaveLength(2);
  });

  it('fails after one reinstall when the helper stays missing', async () => {
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new HelperNotInstalledError('Snapshot helper is not installed'),
    );

    await expect(backend.setClipboard(SECRET)).rejects.toBeInstanceOf(
      HelperNotInstalledError,
    );
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
    expect(clipboardCalls()).toHaveLength(0);
  });

  it('fails clearly when the bundled helper predates clipboard support', async () => {
    mockLoadHelperArtifact.mockResolvedValue(artifact(null));

    await expect(backend.setClipboard(SECRET)).rejects.toThrow(
      /predates clipboard support/u,
    );
    expect(clipboardCalls()).toHaveLength(0);
  });

  it('surfaces a helper failure without the text', async () => {
    mockExec.mockResolvedValue({
      stdout:
        'INSTRUMENTATION_RESULT: ok=false\r\nINSTRUMENTATION_RESULT: errorType=java.lang.SecurityException\r\nINSTRUMENTATION_CODE: -1\r\n',
      stderr: '',
      exitCode: 0,
    });

    const error = await backend.setClipboard(SECRET).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(String(error)).toMatch(/SecurityException/u);
    expect(String(error)).not.toContain('umbrella');
  });

  it('does not support reading the clipboard', async () => {
    await expect(backend.getClipboard()).rejects.toThrow(/not supported/u);
  });
});
