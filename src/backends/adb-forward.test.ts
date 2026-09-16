import { describe, expect, it, vi } from 'vitest';

import {
  forwardWebViewSocket,
  listWebViewSockets,
  parseWebViewSockets,
  removeWebViewForward,
  resolvePackagePids,
  selectWebViewSocket,
} from './adb-forward.js';

function assertErr<Res extends { ok: boolean }>(
  value: Res,
): asserts value is Extract<Res, { ok: false }> {
  expect(value.ok).toBe(false);
}

const PROC_NET_UNIX = `Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 82669 @webview_devtools_remote_12595
0000000000000000: 00000002 00000000 00010000 0001 01 12345 @some_other_socket
0000000000000000: 00000002 00000000 00010000 0001 01 82670 @webview_devtools_remote_20001`;

describe('parseWebViewSockets', () => {
  it('extracts webview devtools sockets with pids', () => {
    const sockets = parseWebViewSockets(PROC_NET_UNIX);
    expect(sockets).toStrictEqual([
      { name: 'webview_devtools_remote_12595', pid: 12595 },
      { name: 'webview_devtools_remote_20001', pid: 20001 },
    ]);
  });

  it('handles the legacy unsuffixed socket name', () => {
    const sockets = parseWebViewSockets(
      '0000: 00 00 00 0001 01 1 @webview_devtools_remote',
    );
    expect(sockets).toStrictEqual([{ name: 'webview_devtools_remote' }]);
  });

  it('handles a NUL-prefixed abstract name', () => {
    const sockets = parseWebViewSockets(
      '0000: 00 00 00 0001 01 1 \u0000webview_devtools_remote_777',
    );
    expect(sockets).toStrictEqual([
      { name: 'webview_devtools_remote_777', pid: 777 },
    ]);
  });

  it('returns empty when no webview socket is present', () => {
    expect(parseWebViewSockets('0000: ... @foo_bar')).toStrictEqual([]);
  });
});

describe('listWebViewSockets', () => {
  it('reads /proc/net/unix via adb', async () => {
    const adb = vi.fn().mockResolvedValue(PROC_NET_UNIX);
    const sockets = await listWebViewSockets(adb);
    expect(adb).toHaveBeenCalledWith(['shell', 'cat', '/proc/net/unix']);
    expect(sockets).toHaveLength(2);
  });
});

describe('resolvePackagePids', () => {
  it('parses pidof output', async () => {
    const adb = vi.fn().mockResolvedValue('12595 20001\n');
    const pids = await resolvePackagePids(adb, 'io.metamask');
    expect(adb).toHaveBeenCalledWith(['shell', 'pidof', 'io.metamask']);
    expect(pids).toStrictEqual([12595, 20001]);
  });

  it('returns empty when pidof fails', async () => {
    const adb = vi.fn().mockRejectedValue(new Error('no such process'));
    const pids = await resolvePackagePids(adb, 'io.metamask');
    expect(pids).toStrictEqual([]);
  });
});

describe('selectWebViewSocket', () => {
  it('fails with none when there are no sockets', () => {
    const result = selectWebViewSocket([], []);
    assertErr(result);
    expect(result.reason).toBe('none');
  });

  it('uses the single socket when only one exists', () => {
    const result = selectWebViewSocket(
      [{ name: 'webview_devtools_remote_1', pid: 1 }],
      [],
    );
    expect(result).toStrictEqual({
      ok: true,
      name: 'webview_devtools_remote_1',
    });
  });

  it('prefers a socket owned by an app pid', () => {
    const result = selectWebViewSocket(
      [
        { name: 'webview_devtools_remote_111', pid: 111 },
        { name: 'webview_devtools_remote_222', pid: 222 },
      ],
      [222],
    );
    expect(result).toStrictEqual({
      ok: true,
      name: 'webview_devtools_remote_222',
    });
  });

  it('warns when the sole socket is not owned by known app pids', () => {
    const result = selectWebViewSocket(
      [{ name: 'webview_devtools_remote_999', pid: 999 }],
      [111, 222],
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      name: 'webview_devtools_remote_999',
    });
    expect((result as { warning?: string }).warning).toContain('111, 222');
  });

  it('collapses duplicate socket names (listener + connection) to one', () => {
    // /proc/net/unix lists the same abstract socket once per endpoint, so an
    // active adb-forward connection makes the sole socket appear twice.
    const result = selectWebViewSocket(
      [
        { name: 'webview_devtools_remote_12595', pid: 12595 },
        { name: 'webview_devtools_remote_12595', pid: 12595 },
      ],
      [12595],
    );
    expect(result).toStrictEqual({
      ok: true,
      name: 'webview_devtools_remote_12595',
    });
  });

  it('keeps the pid-bearing entry when a duplicate name lacks a pid', () => {
    const result = selectWebViewSocket(
      [
        { name: 'webview_devtools_remote_777' },
        { name: 'webview_devtools_remote_777', pid: 777 },
      ],
      [777],
    );
    expect(result).toStrictEqual({
      ok: true,
      name: 'webview_devtools_remote_777',
    });
  });

  it('is ambiguous when multiple sockets and none are owned', () => {
    const result = selectWebViewSocket(
      [
        { name: 'webview_devtools_remote_111', pid: 111 },
        { name: 'webview_devtools_remote_222', pid: 222 },
      ],
      [],
    );
    assertErr(result);
    expect(result.reason).toBe('ambiguous');
    expect(result.message).toContain('webview_devtools_remote_111');
  });

  it('is ambiguous when multiple app-owned sockets exist', () => {
    const result = selectWebViewSocket(
      [
        { name: 'webview_devtools_remote_111', pid: 111 },
        { name: 'webview_devtools_remote_222', pid: 222 },
      ],
      [111, 222],
    );
    assertErr(result);
    expect(result.reason).toBe('ambiguous');
  });
});

describe('forwardWebViewSocket / removeWebViewForward', () => {
  it('creates a local abstract forward', async () => {
    const adb = vi.fn().mockResolvedValue('9333');
    await forwardWebViewSocket(adb, 9333, 'webview_devtools_remote_12595');
    expect(adb).toHaveBeenCalledWith([
      'forward',
      'tcp:9333',
      'localabstract:webview_devtools_remote_12595',
    ]);
  });

  it('removes the forward', async () => {
    const adb = vi.fn().mockResolvedValue('');
    await removeWebViewForward(adb, 9333);
    expect(adb).toHaveBeenCalledWith(['forward', '--remove', 'tcp:9333']);
  });

  it('swallows errors when removing the forward', async () => {
    const adb = vi.fn().mockRejectedValue(new Error('not found'));
    expect(await removeWebViewForward(adb, 9333)).toBeUndefined();
  });
});
