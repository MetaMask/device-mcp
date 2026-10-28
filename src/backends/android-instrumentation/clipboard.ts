/**
 * Arguments and result parsing for the helper's clipboard instrumentation
 * (`io.metamask.devicemcp.snapshothelper/.ClipboardInstrumentation`).
 *
 * `cmd clipboard` has no shell implementation on recent Android images and
 * background apps cannot write the clipboard, so the helper sets it from an
 * instrumentation. The text travels base64-encoded so spaces and shell
 * metacharacters survive `am instrument -e`. Callers may pass a secret recovery
 * phrase: nothing here returns, logs, or embeds the text in an error.
 *
 * Orchestration (install, trust check, invoke) lives in the ADB backend.
 */

import { parseInstrumentationOutput } from './snapshot.js';

/** Instrumentation argument carrying the base64-encoded clipboard text. */
export const CLIPBOARD_TEXT_ARG = 'textB64';

/** Lowest `helperApiVersion` that ships the clipboard instrumentation. */
export const CLIPBOARD_MIN_HELPER_API_VERSION = 2;

/**
 * `INSTRUMENTATION_CODE: -1` is `Activity.RESULT_OK`, the helper's success code.
 */
const SUCCESS_INSTRUMENTATION_CODE = '-1';

/**
 * Build the `adb shell` arguments that write `text` to the device clipboard.
 *
 * @param runner - The clipboard instrumentation runner from the artifact.
 * @param text - The text to place on the clipboard.
 * @returns Arguments to pass after `adb -s <serial>`.
 */
export function buildClipboardInstrumentArgs(
  runner: string,
  text: string,
): string[] {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    CLIPBOARD_TEXT_ARG,
    encoded,
    runner,
  ];
}

/**
 * Validate the clipboard instrumentation's output.
 *
 * @param stdout - Raw stdout from `adb shell am instrument -w ...`.
 * @param expectedLength - Length of the text that was sent, in UTF-16 code
 * units (Java's `String.length()`), used to confirm the helper decoded it.
 * @throws When the helper did not report a successful write of the full text.
 * Messages never include the text.
 */
export function assertClipboardWriteSucceeded(
  stdout: string,
  expectedLength: number,
): void {
  const { result, instrumentationCode } = parseInstrumentationOutput(stdout);

  if (result.size === 0) {
    throw new Error(
      'Clipboard helper produced no result record (the instrumentation was ' +
        'interrupted or is not installed).',
    );
  }

  if (result.get('ok') !== 'true') {
    const errorType = result.get('errorType');
    throw new Error(
      `Clipboard helper reported failure${errorType ? ` (${errorType})` : ''}.`,
    );
  }

  if (
    instrumentationCode !== null &&
    instrumentationCode !== SUCCESS_INSTRUMENTATION_CODE
  ) {
    throw new Error(
      `Clipboard helper ended with code ${instrumentationCode} (expected ${SUCCESS_INSTRUMENTATION_CODE}).`,
    );
  }

  const length = Number(result.get('length'));
  if (!Number.isInteger(length) || length !== expectedLength) {
    throw new Error(
      `Clipboard helper wrote ${String(result.get('length'))} characters, expected ${expectedLength}.`,
    );
  }
}
