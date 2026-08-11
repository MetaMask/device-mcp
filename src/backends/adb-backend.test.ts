import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseAndroidHierarchy,
  parseNodeAttributes,
  AdbBackend,
} from './adb-backend.js';
import { findElement } from '../utils/element.js';
import * as execModule from '../utils/exec.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('../utils/exec.js', () => ({
  exec: vi.fn(),
  execStrict: vi.fn(),
  isCommandAvailable: vi.fn().mockResolvedValue(true),
}));

const mockExecStrict = vi.mocked(execModule.execStrict);
const mockExec = vi.mocked(execModule.exec);
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

describe('AdbBackend.snapshot', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new AdbBackend('emulator-5554');
    mockExec.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  afterEach(() => {
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

  /**
   * Run a snapshot with retry backoff elided, so the suite does not truly sleep.
   *
   * @param run - Invokes the operation under test.
   * @returns The settled promise of the operation.
   */
  async function withoutRetryDelay<Result>(
    run: () => Promise<Result>,
  ): Promise<Result> {
    vi.useFakeTimers();
    try {
      // Convert to a settled result before draining timers. Awaiting the raw
      // promise afterwards would leave it unhandled while `runAllTimersAsync`
      // yields, which Vitest reports as an unhandled rejection.
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
    ).rejects.toThrow('uiautomator failed to capture the UI hierarchy');

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
    ).rejects.toThrow('uiautomator failed to capture the UI hierarchy');
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
