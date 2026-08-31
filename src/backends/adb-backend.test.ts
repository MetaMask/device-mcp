/* eslint-disable n/no-process-env -- these tests toggle DEVICE_MCP_ADB_SNAPSHOT to exercise snapshot-mode selection */
import { readFile, readdir } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseAndroidHierarchy,
  parseNodeAttributes,
  AdbBackend,
} from './adb-backend.js';
import { UntrustedHelperError } from './android-instrumentation/errors.js';
import {
  assertInstalledHelperTrusted,
  ensureHelperInstalled,
} from './android-instrumentation/installer.js';
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
  ensureHelperInstalled: vi.fn().mockResolvedValue(undefined),
  assertInstalledHelperTrusted: vi.fn().mockResolvedValue(undefined),
  INSTRUMENTATION_NOT_FOUND_SIGNATURE: 'INSTRUMENTATION_FAILED',
}));

const mockExecStrict = vi.mocked(execModule.execStrict);
const mockExec = vi.mocked(execModule.exec);
const mockReadFile = vi.mocked(readFile);
const mockEnsureHelperInstalled = vi.mocked(ensureHelperInstalled);
const mockAssertInstalledHelperTrusted = vi.mocked(
  assertInstalledHelperTrusted,
);
const mockReaddir = vi.mocked(readdir);

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

/**
 * Encode hierarchy XML into the chunked base64 status stream that
 * `am instrument -w` emits, with CRLF line endings like adb shell.
 *
 * @param xml - The hierarchy XML the helper would stream.
 * @returns Raw `am instrument` stdout.
 */
function buildInstrumentStdout(xml: string): string {
  const bytes = Buffer.from(xml, 'utf8');
  const chunkSize = 2048;
  const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const lines: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    lines.push(`INSTRUMENTATION_STATUS: chunkCount=${chunkCount}`);
    lines.push(`INSTRUMENTATION_STATUS: chunkIndex=${index}`);
    lines.push(
      `INSTRUMENTATION_STATUS: payloadBase64=${slice.toString('base64')}`,
    );
    lines.push('INSTRUMENTATION_STATUS_CODE: 2');
  }
  lines.push('INSTRUMENTATION_RESULT: ok=true');
  lines.push('INSTRUMENTATION_CODE: -1');
  return lines.join('\r\n');
}

const INSTRUMENT_XML =
  `<?xml version='1.0'?><hierarchy rotation="0">` +
  `<node index="0" bounds="[0,0][1080,2274]" class="android.view.View" ` +
  `package="io.metamask" resource-id="tab-bar-item-Wallet" text="Wallet" />` +
  `</hierarchy>`;

describe('AdbBackend.snapshot snapshot-mode selection', () => {
  let backend: AdbBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new AdbBackend('emulator-5554');
    // Install and signer-verify are separate concerns: install is version-gated
    // and cacheable, while the signer check must run on every snapshot. Both are
    // resolved stubs by default; the installer has its own tests.
    mockEnsureHelperInstalled.mockResolvedValue(undefined);
    mockAssertInstalledHelperTrusted.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.DEVICE_MCP_ADB_SNAPSHOT;
    mockExec.mockReset();
    mockExecStrict.mockReset();
    mockReaddir.mockReset();
  });

  /**
   * Route `exec('adb', ...)` calls by their sub-command.
   *
   * @param overrides - Per-command stdout/exit overrides.
   * @param overrides.dumpCat - stdout returned by `cat` of the dump file.
   * @param overrides.helperInstalled - Whether `pm list packages` reports it.
   * @param overrides.instrumentStdout - stdout returned by `am instrument`.
   */
  function routeExec(overrides: {
    dumpCat?: string;
    helperInstalled?: boolean;
    instrumentStdout?: string;
  }): void {
    mockExecStrict.mockImplementation(async (_cmd, args) => {
      if (args?.includes('cat')) {
        return overrides.dumpCat ?? '';
      }
      return '';
    });
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args?.includes('instrument')) {
        return {
          stdout: overrides.instrumentStdout ?? '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args?.includes('packages')) {
        return {
          stdout: overrides.helperInstalled
            ? 'package:io.metamask.devicemcp.snapshothelper'
            : '',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args?.includes('install')) {
        return { stdout: 'Success', stderr: '', exitCode: 0 };
      }
      // dump / cat / rm / other
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  }

  it('auto: returns the quick dump when the screen is idle', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
    routeExec({
      dumpCat:
        '<hierarchy><node class="T" text="idle" bounds="[0,0][1,1]" /></hierarchy>',
    });

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].value).toBe('idle');
    // The instrumentation path must not run when the quick dump succeeds.
    expect(
      mockExec.mock.calls.some((call) => call[1]?.includes('instrument')),
    ).toBe(false);
  });

  it('auto: falls back to instrumentation when the dump never idles', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
    routeExec({
      dumpCat: '', // dump yields no hierarchy (churny screen)
      helperInstalled: true,
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
    expect(
      mockExec.mock.calls.some((call) => call[1]?.includes('instrument')),
    ).toBe(true);
  });

  it('auto: ensures a trusted helper before instrumenting', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'auto';
    routeExec({
      dumpCat: '',
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });

    await backend.snapshot();

    expect(mockEnsureHelperInstalled).toHaveBeenCalledWith('emulator-5554');
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledWith(
      'emulator-5554',
    );
  });

  it('instrument: uses only the helper and never dumps', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    routeExec({
      helperInstalled: true,
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });

    const snapshot = await backend.snapshot();

    expect(snapshot.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');
    expect(mockExec.mock.calls.some((call) => call[1]?.includes('dump'))).toBe(
      false,
    );
  });

  it('instrument: surfaces a composed failure when the helper fails', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    mockExecStrict.mockResolvedValue('');
    mockExec.mockImplementation(async (_cmd, args) => {
      if (args?.includes('instrument')) {
        return {
          stdout: 'INSTRUMENTATION_RESULT: ok=false\r\nINSTRUMENTATION_CODE: 0',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args?.includes('packages')) {
        return {
          stdout: 'package:io.metamask.devicemcp.snapshothelper',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    await expect(backend.snapshot()).rejects.toThrow(
      /Failed to capture the UI hierarchy[\s\S]*instrument:/u,
    );
  });

  it('caches the install but re-verifies the signer on every snapshot', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    routeExec({
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });

    await backend.snapshot();
    await backend.snapshot();

    // The install is version-gated and cached: it runs once per session.
    expect(mockEnsureHelperInstalled).toHaveBeenCalledTimes(1);
    // The signer trust check is a per-use invariant: it must run on EVERY
    // am instrument, never cached, so a mid-session same-package swap is caught.
    expect(mockAssertInstalledHelperTrusted).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the installed signer changes after an earlier trusted snapshot', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    routeExec({
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });

    // Snapshot 1: the installed helper is trusted and the capture succeeds.
    const first = await backend.snapshot();
    expect(first.hierarchy[0].identifier).toBe('tab-bar-item-Wallet');

    // Between snapshots an attacker uninstalls the real helper and installs a
    // malicious same-package instrumentation. The install stays cached, so only
    // the per-use signer verification can catch the swap. It must fail closed
    // and never fall back to a uiautomator dump — this is the exact exploit the
    // per-use trust invariant closes.
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
    routeExec({
      dumpCat: '',
      instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML),
    });
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'aaaa',
        actualSignerSha256: 'bbbb',
      }),
    );

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
    // The single quick probe may run first, but the trust error must abort
    // BEFORE the multi-attempt dump fallback: only one uiautomator dump total.
    const dumpCalls = mockExec.mock.calls.filter((call) =>
      call[1]?.includes('uiautomator'),
    );
    expect(dumpCalls.length).toBeLessThanOrEqual(1);
  });

  it('instrument: propagates a trust error unchanged', async () => {
    process.env.DEVICE_MCP_ADB_SNAPSHOT = 'instrument';
    routeExec({ instrumentStdout: buildInstrumentStdout(INSTRUMENT_XML) });
    mockAssertInstalledHelperTrusted.mockRejectedValue(
      new UntrustedHelperError('signer mismatch', {
        expectedSignerSha256: 'aaaa',
      }),
    );

    await expect(backend.snapshot()).rejects.toBeInstanceOf(
      UntrustedHelperError,
    );
  });
});
