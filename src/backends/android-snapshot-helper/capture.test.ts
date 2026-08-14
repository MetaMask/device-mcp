import { describe, it, expect, vi } from 'vitest';

import {
  captureAndroidSnapshotWithHelper,
  parseAndroidSnapshotHelperOutput,
} from './capture.js';
import { SnapshotHelperError } from './errors.js';
import type { AndroidAdbExecutor } from './types.js';

const XML = '<?xml version="1.0"?><hierarchy rotation="0"></hierarchy>';

function statusChunk(
  index: number,
  count: number,
  payload: string,
  extra = '',
): string {
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    `INSTRUMENTATION_STATUS: chunkIndex=${index}`,
    `INSTRUMENTATION_STATUS: chunkCount=${count}`,
    `INSTRUMENTATION_STATUS: payloadBase64=${payload}`,
    extra,
    'INSTRUMENTATION_STATUS_CODE: 1',
  ]
    .filter(Boolean)
    .join('\n');
}

function successResult(xml: string, extra: string[] = []): string {
  const payload = Buffer.from(xml, 'utf8').toString('base64');
  return [
    statusChunk(0, 1, payload),
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    ...extra.map((line) => `INSTRUMENTATION_RESULT: ${line}`),
    'INSTRUMENTATION_CODE: -1',
  ].join('\n');
}

describe('parseAndroidSnapshotHelperOutput', () => {
  it('reassembles a single-chunk XML payload', () => {
    const result = parseAndroidSnapshotHelperOutput(successResult(XML));
    expect(result.xml).toBe(XML);
    expect(result.metadata.helperApiVersion).toBe('1');
    expect(result.metadata.outputFormat).toBe('uiautomator-xml');
  });

  it('reassembles multi-chunk payloads in index order', () => {
    const full = `<?xml version="1.0"?><hierarchy>${'a'.repeat(20)}</hierarchy>`;
    const bytes = Buffer.from(full, 'utf8');
    const mid = Math.floor(bytes.length / 2);
    const first = bytes.subarray(0, mid).toString('base64');
    const second = bytes.subarray(mid).toString('base64');
    const output = [
      statusChunk(1, 2, second),
      statusChunk(0, 2, first),
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=true',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n');

    expect(parseAndroidSnapshotHelperOutput(output).xml).toBe(full);
  });

  it('reads typed metadata from the final result', () => {
    const output = successResult(XML, [
      'nodeCount=42',
      'rootPresent=true',
      'captureMode=interactive-windows',
      'elapsedMs=123',
    ]);
    const { metadata } = parseAndroidSnapshotHelperOutput(output);
    expect(metadata.nodeCount).toBe(42);
    expect(metadata.rootPresent).toBe(true);
    expect(metadata.captureMode).toBe('interactive-windows');
    expect(metadata.elapsedMs).toBe(123);
  });

  it('throws when the helper reports ok=false', () => {
    const output = [
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=false',
      'INSTRUMENTATION_RESULT: errorType=CaptureFailed',
      'INSTRUMENTATION_RESULT: message=no root window',
      'INSTRUMENTATION_CODE: 0',
    ].join('\n');
    expect(() => parseAndroidSnapshotHelperOutput(output)).toThrow(
      'no root window',
    );
  });

  it('throws when no final result is present', () => {
    expect(() => parseAndroidSnapshotHelperOutput('random noise')).toThrow(
      SnapshotHelperError,
    );
  });

  it('throws when chunk counts are inconsistent', () => {
    const payload = Buffer.from(XML, 'utf8').toString('base64');
    const output = [
      statusChunk(0, 2, payload),
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=true',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n');
    expect(() => parseAndroidSnapshotHelperOutput(output)).toThrow(
      'incomplete XML chunks',
    );
  });

  it('rejects payloads that decode without a hierarchy element', () => {
    const payload = Buffer.from('<not-xml/>', 'utf8').toString('base64');
    const output = [
      statusChunk(0, 1, payload),
      'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
      'INSTRUMENTATION_RESULT: ok=true',
      'INSTRUMENTATION_CODE: -1',
    ].join('\n');
    expect(() => parseAndroidSnapshotHelperOutput(output)).toThrow(
      'did not contain XML',
    );
  });
});

describe('captureAndroidSnapshotWithHelper', () => {
  it('invokes am instrument with the helper runner and default extras', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML),
      stderr: '',
      exitCode: 0,
    });

    const result = await captureAndroidSnapshotWithHelper({
      adb,
      packageName: 'com.example.helper',
      instrumentationRunner: 'com.example.helper/.SnapshotInstrumentation',
    });

    expect(result.xml).toBe(XML);
    expect(adb).toHaveBeenCalledWith(
      [
        'shell',
        'am',
        'instrument',
        '-w',
        '-e',
        'waitForIdleTimeoutMs',
        '500',
        '-e',
        'timeoutMs',
        '8000',
        '-e',
        'maxDepth',
        '128',
        '-e',
        'maxNodes',
        '5000',
        'com.example.helper/.SnapshotInstrumentation',
      ],
      { allowFailure: true, timeoutMs: 13_000 },
    );
  });

  it('throws when am instrument exits non-zero', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML),
      stderr: '',
      exitCode: 1,
    });
    await expect(captureAndroidSnapshotWithHelper({ adb })).rejects.toThrow(
      'Android snapshot helper failed',
    );
  });

  it('rejects an ok=true capture that reports no accessibility root', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML, ['rootPresent=false']),
      stderr: '',
      exitCode: 0,
    });
    await expect(captureAndroidSnapshotWithHelper({ adb })).rejects.toThrow(
      'captured no accessibility root window',
    );
  });

  it('rejects an ok=true capture that was truncated', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML, [
        'rootPresent=true',
        'nodeCount=5000',
        'truncated=true',
      ]),
      stderr: '',
      exitCode: 0,
    });
    await expect(captureAndroidSnapshotWithHelper({ adb })).rejects.toThrow(
      'truncated the accessibility hierarchy',
    );
  });

  it('rejects an ok=true capture with an empty hierarchy', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML, ['windowCount=0', 'nodeCount=0']),
      stderr: '',
      exitCode: 0,
    });
    await expect(captureAndroidSnapshotWithHelper({ adb })).rejects.toThrow(
      'captured an empty accessibility hierarchy',
    );
  });

  it('rejects an ok=true capture with zero nodes but a window frame', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML, [
        'rootPresent=true',
        'windowCount=1',
        'nodeCount=0',
      ]),
      stderr: '',
      exitCode: 0,
    });
    await expect(captureAndroidSnapshotWithHelper({ adb })).rejects.toThrow(
      'captured an empty accessibility hierarchy',
    );
  });

  it('accepts a complete ok=true capture', async () => {
    const adb = vi.fn<AndroidAdbExecutor>().mockResolvedValue({
      stdout: successResult(XML, [
        'rootPresent=true',
        'windowCount=1',
        'nodeCount=1',
        'truncated=false',
      ]),
      stderr: '',
      exitCode: 0,
    });
    const result = await captureAndroidSnapshotWithHelper({ adb });
    expect(result.xml).toBe(XML);
  });
});
