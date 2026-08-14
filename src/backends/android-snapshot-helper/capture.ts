// Derived from agent-device (MIT, Copyright (c) 2026 Callstack)
// https://github.com/callstackincubator/agent-device/blob/336bf17af44e9be1810592d5dc42163771c3e8de/src/platforms/android/snapshot-helper-capture.ts
// See ./vendor/NOTICE.md and ./vendor/LICENSE.MIT for attribution.

import { SnapshotHelperError } from './errors.js';
import {
  ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS,
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PACKAGE,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS,
} from './types.js';
import type {
  AndroidSnapshotHelperCaptureMode,
  AndroidSnapshotHelperCaptureOptions,
  AndroidSnapshotHelperMetadata,
  AndroidSnapshotHelperOutput,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_DEPTH = 128;
const DEFAULT_MAX_NODES = 5_000;

type HelperChunk = {
  index?: number;
  count?: number;
  payloadBase64: string;
};

type InstrumentationRecordState = {
  status: Record<string, string>[];
  results: Record<string, string>[];
  currentStatus: Record<string, string> | null;
  currentResult: Record<string, string> | null;
};

export async function captureAndroidSnapshotWithHelper(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<AndroidSnapshotHelperOutput> {
  const waitForIdleTimeoutMs =
    options.waitForIdleTimeoutMs ??
    ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const commandTimeoutMs =
    options.commandTimeoutMs ??
    timeoutMs + ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const packageName = options.packageName ?? ANDROID_SNAPSHOT_HELPER_PACKAGE;
  const runner =
    options.instrumentationRunner ?? `${packageName}/.SnapshotInstrumentation`;

  const result = await options.adb(
    [
      'shell',
      'am',
      'instrument',
      '-w',
      '-e',
      'waitForIdleTimeoutMs',
      String(waitForIdleTimeoutMs),
      '-e',
      'timeoutMs',
      String(timeoutMs),
      '-e',
      'maxDepth',
      String(maxDepth),
      '-e',
      'maxNodes',
      String(maxNodes),
      runner,
    ],
    { allowFailure: true, timeoutMs: commandTimeoutMs },
  );

  // `am instrument` interleaves the helper protocol across stdout and stderr.
  const output = `${result.stdout}\n${result.stderr}`;

  let parsed: AndroidSnapshotHelperOutput;
  try {
    parsed = parseAndroidSnapshotHelperOutput(output);
  } catch (error) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      result.exitCode === 0
        ? 'Android snapshot helper output could not be parsed'
        : 'Android snapshot helper failed before returning parseable output',
      {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      error,
    );
  }

  if (result.exitCode !== 0) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper failed',
      {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        helper: parsed.metadata,
      },
    );
  }

  assertHelperCaptureComplete(parsed.metadata);

  return parsed;
}

// Security: the helper reports `ok=true` for semantically incomplete captures
// (no accessibility root, a window skipped mid-traversal, or a tree truncated at
// the maxDepth/maxNodes caps), so `ok` alone cannot be trusted. A wallet must
// fail closed rather than act on a partial confirmation screen — a dropped
// overlay would expose the underlying elements as if tappable — so reject on the
// explicit negative completeness signals the helper reports.
function assertHelperCaptureComplete(
  metadata: AndroidSnapshotHelperMetadata,
): void {
  if (metadata.rootPresent === false) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper captured no accessibility root window',
      { helper: metadata },
    );
  }

  if (metadata.truncated === true) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper truncated the accessibility hierarchy',
      { helper: metadata },
    );
  }

  // Security: reject on an explicit zero for either count (`||`, not `&&`) — a
  // nodeCount of 0 is an empty tree the agent would act on even when a window
  // frame is reported. Absent (undefined) counts are tolerated because some
  // legitimate helper responses omit them and the XML envelope was already
  // verified upstream.
  if (metadata.windowCount === 0 || metadata.nodeCount === 0) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper captured an empty accessibility hierarchy',
      { helper: metadata },
    );
  }
}

export function parseAndroidSnapshotHelperOutput(
  output: string,
): AndroidSnapshotHelperOutput {
  const records = parseInstrumentationRecords(output);
  const finalResult = readFinalHelperResult(records.results);
  const xml = decodeHelperXml(collectHelperChunks(records.status), finalResult);
  return { xml, metadata: readHelperMetadata(finalResult) };
}

// `am instrument` emits records as `INSTRUMENTATION_STATUS: key=value` lines
// accumulated until a `INSTRUMENTATION_STATUS_CODE:` line closes the record;
// `INSTRUMENTATION_RESULT:`/`INSTRUMENTATION_CODE:` do the same for the final
// result. The closing code lines are terminators, not key/value pairs.
function parseInstrumentationRecords(output: string): {
  status: Record<string, string>[];
  results: Record<string, string>[];
} {
  const state: InstrumentationRecordState = {
    status: [],
    results: [],
    currentStatus: null,
    currentResult: null,
  };
  for (const line of output.split(/\r?\n/u)) {
    readInstrumentationRecordLine(line, state);
  }
  flushStatusRecord(state);
  flushResultRecord(state);
  return { status: state.status, results: state.results };
}

function readInstrumentationRecordLine(
  line: string,
  state: InstrumentationRecordState,
): void {
  if (line.startsWith('INSTRUMENTATION_STATUS: ')) {
    state.currentStatus ??= {};
    readKeyValue(
      line.slice('INSTRUMENTATION_STATUS: '.length),
      state.currentStatus,
    );
    return;
  }
  if (line.startsWith('INSTRUMENTATION_STATUS_CODE: ')) {
    flushStatusRecord(state);
    return;
  }
  if (line.startsWith('INSTRUMENTATION_RESULT: ')) {
    state.currentResult ??= {};
    readKeyValue(
      line.slice('INSTRUMENTATION_RESULT: '.length),
      state.currentResult,
    );
    return;
  }
  if (line.startsWith('INSTRUMENTATION_CODE: ')) {
    flushResultRecord(state);
  }
}

function flushStatusRecord(state: InstrumentationRecordState): void {
  if (state.currentStatus) {
    state.status.push(state.currentStatus);
    state.currentStatus = null;
  }
}

function flushResultRecord(state: InstrumentationRecordState): void {
  if (state.currentResult) {
    state.results.push(state.currentResult);
    state.currentResult = null;
  }
}

function readKeyValue(line: string, target: Record<string, string>): void {
  const separator = line.indexOf('=');
  if (separator < 0) {
    return;
  }
  target[line.slice(0, separator)] = line.slice(separator + 1);
}

function readFinalHelperResult(
  records: Record<string, string>[],
): Record<string, string> {
  const finalResult = records.find(
    (record) => record.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  );
  if (!finalResult) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper did not return a final result',
    );
  }
  if (finalResult.ok !== 'true') {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      readHelperErrorMessage(finalResult),
      { errorType: finalResult.errorType, helper: finalResult },
    );
  }
  return finalResult;
}

function readHelperErrorMessage(result: Record<string, string>): string {
  if (result.message && result.message !== 'null') {
    return result.message;
  }
  return result.errorType ?? 'Android snapshot helper returned an error';
}

function collectHelperChunks(records: Record<string, string>[]): HelperChunk[] {
  return records
    .filter(
      (record) =>
        record.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL &&
        record.outputFormat === ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT &&
        typeof record.payloadBase64 === 'string',
    )
    .map((record) => ({
      index: readOptionalNumber(record.chunkIndex),
      count: readOptionalNumber(record.chunkCount),
      payloadBase64: record.payloadBase64,
    }));
}

function decodeHelperXml(
  chunks: HelperChunk[],
  finalResult: Record<string, string>,
): string {
  if (chunks.length === 0) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper did not return XML chunks',
      { helper: finalResult },
    );
  }
  const chunkCount = validateChunkCount(chunks);
  const xml = Buffer.concat(
    readChunkPayloads(indexChunks(chunks, chunkCount), chunkCount),
  ).toString('utf8');
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper output did not contain XML',
      { helper: finalResult },
    );
  }
  return xml;
}

function validateChunkCount(chunks: HelperChunk[]): number {
  const chunkCount = chunks[0]?.count ?? chunks.length;
  if (
    chunkCount < 1 ||
    chunks.length !== chunkCount ||
    chunks.some((chunk) => chunk.count !== chunkCount)
  ) {
    throw new SnapshotHelperError(
      'COMMAND_FAILED',
      'Android snapshot helper returned incomplete XML chunks',
      { expectedChunks: chunkCount, actualChunks: chunks.length },
    );
  }
  return chunkCount;
}

function indexChunks(
  chunks: HelperChunk[],
  chunkCount: number,
): Map<number, string> {
  const chunksByIndex = new Map<number, string>();
  for (const chunk of chunks) {
    if (
      chunk.index === undefined ||
      chunk.index < 0 ||
      chunk.index >= chunkCount
    ) {
      throw new SnapshotHelperError(
        'COMMAND_FAILED',
        'Android snapshot helper returned an invalid chunk index',
        { chunkIndex: chunk.index, chunkCount },
      );
    }
    if (chunksByIndex.has(chunk.index)) {
      throw new SnapshotHelperError(
        'COMMAND_FAILED',
        'Android snapshot helper returned duplicate XML chunks',
        { chunkIndex: chunk.index },
      );
    }
    chunksByIndex.set(chunk.index, chunk.payloadBase64);
  }
  return chunksByIndex;
}

function readChunkPayloads(
  chunksByIndex: Map<number, string>,
  chunkCount: number,
): Buffer[] {
  const payloads: Buffer[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const payloadBase64 = chunksByIndex.get(index);
    if (payloadBase64 === undefined) {
      throw new SnapshotHelperError(
        'COMMAND_FAILED',
        'Android snapshot helper returned incomplete XML chunks',
        { missingChunkIndex: index, expectedChunks: chunkCount },
      );
    }
    payloads.push(Buffer.from(payloadBase64, 'base64'));
  }
  return payloads;
}

function readHelperMetadata(
  finalResult: Record<string, string>,
): AndroidSnapshotHelperMetadata {
  return {
    helperApiVersion: finalResult.helperApiVersion,
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    waitForIdleTimeoutMs: readOptionalNumber(finalResult.waitForIdleTimeoutMs),
    timeoutMs: readOptionalNumber(finalResult.timeoutMs),
    maxDepth: readOptionalNumber(finalResult.maxDepth),
    maxNodes: readOptionalNumber(finalResult.maxNodes),
    rootPresent: readOptionalBoolean(finalResult.rootPresent),
    captureMode: readOptionalCaptureMode(finalResult.captureMode),
    windowCount: readOptionalNumber(finalResult.windowCount),
    nodeCount: readOptionalNumber(finalResult.nodeCount),
    truncated: readOptionalBoolean(finalResult.truncated),
    elapsedMs: readOptionalNumber(finalResult.elapsedMs),
  };
}

function readOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === 'true';
}

function readOptionalCaptureMode(
  value: string | undefined,
): AndroidSnapshotHelperCaptureMode | undefined {
  if (value === 'interactive-windows' || value === 'active-window') {
    return value;
  }
  return undefined;
}
