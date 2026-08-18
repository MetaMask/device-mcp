/**
 * Parser for the in-repo Android snapshot-helper instrumentation.
 *
 * The stock `uiautomator dump` calls `UiAutomation.waitForIdle(1000, 10000)`,
 * which never returns on a continuously-redrawing React Native screen (the
 * MetaMask homepage emits accessibility events at ~10Hz indefinitely). The
 * helper APK (`io.metamask.devicemcp.snapshothelper/.SnapshotInstrumentation`)
 * skips that idle wait and streams the hierarchy back as chunked base64 over
 * `am instrument` status records.
 *
 * This module contains only the pure parsing of that output so it can be tested
 * without a device. The orchestration (install, invoke, fall back) lives in the
 * ADB backend.
 */

/** Emitted as `agentDeviceProtocol` in every status and result record. */
export const HELPER_PROTOCOL = 'device-mcp-snapshot-helper-v1';

/** The instrumentation component `am instrument` targets. */
export const HELPER_PACKAGE = 'io.metamask.devicemcp.snapshothelper';

/** Fully-qualified instrumentation runner name. */
export const HELPER_INSTRUMENTATION = `${HELPER_PACKAGE}/.SnapshotInstrumentation`;

/**
 * A single decoded status record from an `am instrument -w` run.
 *
 * `am instrument` prints key/value lines under `INSTRUMENTATION_STATUS:` and
 * `INSTRUMENTATION_RESULT:` banners. The helper emits one status record per
 * hierarchy chunk and one final result record.
 */
type Record = Map<string, string>;

/**
 * Parse a value out of a raw `am instrument` line.
 *
 * @param line - A single output line, already stripped of its trailing CR.
 * @param prefix - The banner prefix (`INSTRUMENTATION_STATUS: ` etc.).
 * @returns The `key`/`value` pair, or null when the line is not a `key=value`.
 */
function parseKeyValue(
  line: string,
  prefix: string,
): { key: string; value: string } | null {
  if (!line.startsWith(prefix)) {
    return null;
  }
  const body = line.slice(prefix.length);
  const eq = body.indexOf('=');
  if (eq === -1) {
    return null;
  }
  return { key: body.slice(0, eq), value: body.slice(eq + 1) };
}

const STATUS_PREFIX = 'INSTRUMENTATION_STATUS: ';

const RESULT_PREFIX = 'INSTRUMENTATION_RESULT: ';

const STATUS_CODE_PREFIX = 'INSTRUMENTATION_STATUS_CODE:';

const RESULT_CODE_PREFIX = 'INSTRUMENTATION_CODE:';

/**
 * `INSTRUMENTATION_CODE: -1` is `Activity.RESULT_FIRST_USER`, the helper's
 * success sentinel. Any other terminal code means the run did not finish
 * cleanly.
 */
const SUCCESS_INSTRUMENTATION_CODE = '-1';

/**
 * Structured view of one `am instrument` run's output.
 */
type ParsedInstrumentationOutput = {
  /** Status records grouped by their `chunkIndex`. */
  chunks: Map<number, string>;
  /** The `chunkCount` the helper advertised, if any status record carried it. */
  chunkCount: number | null;
  /** Key/value pairs from the final `INSTRUMENTATION_RESULT:` record. */
  result: Record;
  /** The terminal `INSTRUMENTATION_CODE:` value, if present. */
  instrumentationCode: string | null;
};

/**
 * Split raw `am instrument -w` stdout into chunks, result, and terminal code.
 *
 * Handles the CRLF line endings adb injects and tolerates duplicate or
 * interleaved status records by keying chunks on their advertised index.
 *
 * @param stdout - Raw stdout from `adb shell am instrument -w ...`.
 * @returns The grouped records.
 */
export function parseInstrumentationOutput(
  stdout: string,
): ParsedInstrumentationOutput {
  const chunks = new Map<number, string>();
  const result: Record = new Map();
  let chunkCount: number | null = null;
  let instrumentationCode: string | null = null;

  // adb terminates lines with CRLF; the trailing CR would corrupt base64.
  const lines = stdout.replace(/\r/gu, '').split('\n');

  let pendingChunkIndex: number | null = null;

  for (const line of lines) {
    const status = parseKeyValue(line, STATUS_PREFIX);
    if (status) {
      if (status.key === 'chunkIndex') {
        const index = Number.parseInt(status.value, 10);
        pendingChunkIndex = Number.isNaN(index) ? null : index;
      } else if (status.key === 'chunkCount') {
        const count = Number.parseInt(status.value, 10);
        if (!Number.isNaN(count)) {
          chunkCount = count;
        }
      } else if (status.key === 'payloadBase64' && pendingChunkIndex !== null) {
        chunks.set(pendingChunkIndex, status.value);
      }
      continue;
    }

    const resultPair = parseKeyValue(line, RESULT_PREFIX);
    if (resultPair) {
      result.set(resultPair.key, resultPair.value);
      continue;
    }

    if (line.startsWith(STATUS_CODE_PREFIX)) {
      // A status record has ended; the next chunk needs its own index line.
      pendingChunkIndex = null;
      continue;
    }

    if (line.startsWith(RESULT_CODE_PREFIX)) {
      instrumentationCode = line.slice(RESULT_CODE_PREFIX.length).trim();
    }
  }

  return { chunks, chunkCount, result, instrumentationCode };
}

/**
 * Reassemble the hierarchy XML from an `am instrument` run.
 *
 * Each chunk is an independently valid base64 encoding of a raw byte slice
 * (`Base64.NO_WRAP`), so the chunks must be decoded individually and their
 * bytes concatenated. Concatenating the base64 strings first and decoding once
 * corrupts the payload wherever a slice length is not a multiple of three.
 *
 * @param stdout - Raw stdout from `adb shell am instrument -w ...`.
 * @returns The reassembled hierarchy XML.
 * @throws If the helper reported failure, chunks are missing, or the payload is
 * not complete hierarchy XML.
 */
export function reassembleInstrumentationXml(stdout: string): string {
  const { chunks, chunkCount, result, instrumentationCode } =
    parseInstrumentationOutput(stdout);

  if (result.size === 0) {
    // No `INSTRUMENTATION_RESULT:` record at all: `am` was killed mid-stream
    // or the runner crashed before finishing. Distinct from a clean failure.
    throw new Error(
      'Snapshot helper produced no result record (the instrumentation was ' +
        'interrupted before it finished).',
    );
  }

  if (result.get('ok') !== 'true') {
    const message = result.get('message');
    const errorType = result.get('errorType');
    const detail = [errorType, message].filter(Boolean).join(': ');
    throw new Error(
      `Snapshot helper reported failure${detail ? ` (${detail})` : ''}.`,
    );
  }

  if (
    instrumentationCode !== null &&
    instrumentationCode !== SUCCESS_INSTRUMENTATION_CODE
  ) {
    throw new Error(
      `Snapshot helper ended with code ${instrumentationCode} (expected ${SUCCESS_INSTRUMENTATION_CODE}).`,
    );
  }

  const expectedCount = chunkCount ?? chunks.size;
  if (expectedCount === 0) {
    throw new Error('Snapshot helper produced no hierarchy chunks.');
  }

  const parts: Buffer[] = [];
  const missing: number[] = [];
  for (let index = 0; index < expectedCount; index += 1) {
    const payload = chunks.get(index);
    if (payload === undefined) {
      missing.push(index);
      continue;
    }
    parts.push(Buffer.from(payload, 'base64'));
  }

  if (missing.length > 0) {
    throw new Error(
      `Snapshot helper output was missing ${missing.length} of ${expectedCount} chunks (indices ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}).`,
    );
  }

  const xml = Buffer.concat(parts).toString('utf8');

  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new Error(
      'Snapshot helper output did not contain complete hierarchy XML.',
    );
  }

  return xml;
}
