import { describe, it, expect } from 'vitest';

import {
  HELPER_INSTRUMENTATION,
  HELPER_PACKAGE,
  HELPER_PROTOCOL,
  parseInstrumentationOutput,
  reassembleInstrumentationXml,
} from './snapshot.js';

/**
 * Encode a raw string into the chunked base64 the helper emits, then render it
 * as `am instrument -w` stdout with CRLF line endings (matching adb shell).
 *
 * @param xml - The hierarchy XML the helper would stream.
 * @param options - Overrides for building malformed fixtures.
 * @param options.chunkSize - Byte slice size per chunk (helper uses 2048).
 * @param options.ok - The `ok` value in the final result record.
 * @param options.omitResult - When true, no result record is emitted (killed am).
 * @param options.instrumentationCode - Terminal code (helper success is -1).
 * @param options.extraResult - Extra key/value pairs for the result record.
 * @returns Raw stdout text.
 */
function buildInstrumentOutput(
  xml: string,
  options: {
    chunkSize?: number;
    ok?: string;
    omitResult?: boolean;
    instrumentationCode?: string | null;
    extraResult?: Record<string, string>;
  } = {},
): string {
  const {
    chunkSize = 2048,
    ok = 'true',
    omitResult = false,
    instrumentationCode = '-1',
    extraResult = {},
  } = options;

  const bytes = Buffer.from(xml, 'utf8');
  const chunkCount = Math.max(1, Math.ceil(bytes.length / chunkSize));
  const lines: string[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    const slice = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
    lines.push(
      `INSTRUMENTATION_STATUS: agentDeviceProtocol=${HELPER_PROTOCOL}`,
    );
    lines.push(`INSTRUMENTATION_STATUS: chunkCount=${chunkCount}`);
    lines.push(`INSTRUMENTATION_STATUS: chunkIndex=${index}`);
    lines.push('INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml');
    lines.push(
      `INSTRUMENTATION_STATUS: payloadBase64=${slice.toString('base64')}`,
    );
    lines.push('INSTRUMENTATION_STATUS_CODE: 2');
  }

  if (!omitResult) {
    lines.push(
      `INSTRUMENTATION_RESULT: agentDeviceProtocol=${HELPER_PROTOCOL}`,
    );
    lines.push(`INSTRUMENTATION_RESULT: ok=${ok}`);
    for (const [key, value] of Object.entries(extraResult)) {
      lines.push(`INSTRUMENTATION_RESULT: ${key}=${value}`);
    }
    if (instrumentationCode !== null) {
      lines.push(`INSTRUMENTATION_CODE: ${instrumentationCode}`);
    }
  }

  // adb shell emits CRLF line endings.
  return lines.join('\r\n');
}

const SAMPLE_XML =
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>` +
  `<hierarchy rotation="0">` +
  `<node index="0" bounds="[0,0][1080,2274]" class="android.widget.FrameLayout" ` +
  `package="io.metamask" resource-id="account-picker" text="Account 1">` +
  `<node index="0" bounds="[0,0][1080,140]" class="android.view.View" ` +
  `resource-id="tab-bar-item-Wallet" text="Wallet" /></node></hierarchy>`;

describe('android-instrumentation/snapshot', () => {
  describe('constants', () => {
    it('targets the self-instrumenting helper component', () => {
      expect(HELPER_PACKAGE).toBe('io.metamask.devicemcp.snapshothelper');
      expect(HELPER_INSTRUMENTATION).toBe(
        'io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation',
      );
    });
  });

  describe('parseInstrumentationOutput', () => {
    it('groups chunks by index and captures the result record', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 40 });
      const parsed = parseInstrumentationOutput(stdout);

      expect(parsed.chunkCount).toBeGreaterThan(1);
      expect(parsed.chunks.size).toBe(parsed.chunkCount);
      expect(parsed.result.get('ok')).toBe('true');
      expect(parsed.instrumentationCode).toBe('-1');
    });

    it('strips CRLF so base64 payloads decode cleanly', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 32 });
      const parsed = parseInstrumentationOutput(stdout);
      for (const payload of parsed.chunks.values()) {
        expect(payload).not.toContain('\r');
        expect(payload).not.toContain('\n');
      }
    });

    it('ignores unknown status keys without erroring', () => {
      const stdout = `INSTRUMENTATION_STATUS: someFutureKey=whatever\r\n${buildInstrumentOutput(
        SAMPLE_XML,
        { chunkSize: 64 },
      )}`;
      const parsed = parseInstrumentationOutput(stdout);
      expect(parsed.result.get('ok')).toBe('true');
    });
  });

  describe('reassembleInstrumentationXml', () => {
    it('reassembles a single-chunk hierarchy', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 4096 });
      expect(reassembleInstrumentationXml(stdout)).toBe(SAMPLE_XML);
    });

    it('reassembles a multi-chunk hierarchy by concatenating decoded bytes', () => {
      // chunkSize 7 forces slice lengths that are not multiples of three, which
      // is exactly the case that breaks concat-base64-then-decode.
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 7 });
      expect(reassembleInstrumentationXml(stdout)).toBe(SAMPLE_XML);
    });

    it('preserves MetaMask resource-ids through reassembly', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 40 });
      const xml = reassembleInstrumentationXml(stdout);
      expect(xml).toContain('resource-id="account-picker"');
      expect(xml).toContain('resource-id="tab-bar-item-Wallet"');
    });

    it('throws with helper detail when ok=false', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, {
        chunkSize: 40,
        ok: 'false',
        extraResult: {
          errorType: 'java.util.concurrent.TimeoutException',
          message: 'idle wait exceeded',
        },
      });
      expect(() => reassembleInstrumentationXml(stdout)).toThrow(
        /reported failure.*TimeoutException.*idle wait exceeded/u,
      );
    });

    it('distinguishes a killed run (no result record) from a clean failure', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, {
        chunkSize: 40,
        omitResult: true,
      });
      expect(() => reassembleInstrumentationXml(stdout)).toThrow(
        /no result record.*interrupted/u,
      );
    });

    it('rejects a non-success terminal instrumentation code', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, {
        chunkSize: 40,
        instrumentationCode: '0',
      });
      expect(() => reassembleInstrumentationXml(stdout)).toThrow(
        /ended with code 0/u,
      );
    });

    it('detects missing chunk indices', () => {
      const stdout = buildInstrumentOutput(SAMPLE_XML, { chunkSize: 40 });
      // Drop the chunkIndex=1 status record entirely.
      const withHole = stdout
        .split('\r\n')
        .filter(
          (line, i, all) =>
            !(
              line === 'INSTRUMENTATION_STATUS: chunkIndex=1' ||
              // also drop that record's payload line (two lines later)
              (all[i - 2] === 'INSTRUMENTATION_STATUS: chunkIndex=1' &&
                line.startsWith('INSTRUMENTATION_STATUS: payloadBase64='))
            ),
        )
        .join('\r\n');
      expect(() => reassembleInstrumentationXml(withHole)).toThrow(
        /missing .* chunks/u,
      );
    });

    it('rejects output that is not complete hierarchy XML', () => {
      const stdout = buildInstrumentOutput('<partial>not hierarchy', {
        chunkSize: 40,
      });
      expect(() => reassembleInstrumentationXml(stdout)).toThrow(
        /complete hierarchy XML/u,
      );
    });

    it('throws when there are no chunks at all', () => {
      const stdout = [
        `INSTRUMENTATION_RESULT: ok=true`,
        `INSTRUMENTATION_CODE: -1`,
      ].join('\r\n');
      expect(() => reassembleInstrumentationXml(stdout)).toThrow(
        /no hierarchy chunks/u,
      );
    });
  });
});
