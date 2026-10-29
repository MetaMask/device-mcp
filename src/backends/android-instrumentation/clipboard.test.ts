import { describe, it, expect } from 'vitest';

import {
  assertClipboardWriteSucceeded,
  buildClipboardInstrumentArgs,
  CLIPBOARD_TEXT_ARG,
} from './clipboard.js';

const RUNNER = 'io.metamask.devicemcp.snapshothelper/.ClipboardInstrumentation';

const SECRET = 'umbrella review narrow orphan fork extra blouse idle';

/**
 * Build `am instrument -w` stdout as the clipboard instrumentation emits it.
 *
 * @param result - Key/value pairs for the `INSTRUMENTATION_RESULT:` record.
 * @param code - The terminal `INSTRUMENTATION_CODE:` value.
 * @returns Raw stdout with adb's CRLF line endings.
 */
function buildStdout(result: Record<string, string>, code = '-1'): string {
  const lines = Object.entries(result).map(
    ([key, value]) => `INSTRUMENTATION_RESULT: ${key}=${value}`,
  );
  lines.push(`INSTRUMENTATION_CODE: ${code}`);
  return `${lines.join('\r\n')}\r\n`;
}

describe('buildClipboardInstrumentArgs', () => {
  it('targets the runner and base64-encodes the text', () => {
    const args = buildClipboardInstrumentArgs(RUNNER, SECRET);

    expect(args.slice(0, 4)).toStrictEqual(['shell', 'am', 'instrument', '-w']);
    expect(args.at(-1)).toBe(RUNNER);
    const index = args.indexOf(CLIPBOARD_TEXT_ARG);
    expect(args[index - 1]).toBe('-e');
    expect(Buffer.from(args[index + 1], 'base64').toString('utf8')).toBe(
      SECRET,
    );
  });

  it('never passes the plain text as an argument', () => {
    const args = buildClipboardInstrumentArgs(RUNNER, SECRET);

    expect(args.join(' ')).not.toContain('umbrella');
  });

  it('keeps shell metacharacters out of the argument', () => {
    const text = `it's $HOME; rm -rf / && echo "x" | cat`;
    const args = buildClipboardInstrumentArgs(RUNNER, text);
    const encoded = args[args.indexOf(CLIPBOARD_TEXT_ARG) + 1];

    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/u);
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(text);
  });
});

describe('assertClipboardWriteSucceeded', () => {
  it('accepts a successful write of the full text', () => {
    expect(() =>
      assertClipboardWriteSucceeded(
        buildStdout({ ok: 'true', length: String(SECRET.length) }),
        SECRET.length,
      ),
    ).not.toThrow();
  });

  it('rejects output with no result record', () => {
    expect(() =>
      assertClipboardWriteSucceeded(
        'INSTRUMENTATION_FAILED: io.metamask.devicemcp.snapshothelper/.ClipboardInstrumentation\r\n',
        5,
      ),
    ).toThrow(/no result record/u);
  });

  it('reports the error type when the helper fails', () => {
    expect(() =>
      assertClipboardWriteSucceeded(
        buildStdout(
          { ok: 'false', errorType: 'java.lang.SecurityException' },
          '-1',
        ),
        5,
      ),
    ).toThrow(/reported failure \(java\.lang\.SecurityException\)/u);
  });

  it('rejects a non-success instrumentation code', () => {
    expect(() =>
      assertClipboardWriteSucceeded(
        buildStdout({ ok: 'true', length: '5' }, '0'),
        5,
      ),
    ).toThrow(/ended with code 0/u);
  });

  it('rejects a length mismatch', () => {
    expect(() =>
      assertClipboardWriteSucceeded(
        buildStdout({ ok: 'true', length: '3' }),
        5,
      ),
    ).toThrow(/wrote 3 characters, expected 5/u);
  });

  it('never includes the text in an error', () => {
    const error = ((): unknown => {
      try {
        assertClipboardWriteSucceeded(
          buildStdout({ ok: 'false', errorType: 'java.lang.Error' }),
          SECRET.length,
        );
        return null;
      } catch (caught) {
        return caught;
      }
    })();

    expect(String(error)).not.toContain('umbrella');
  });
});
