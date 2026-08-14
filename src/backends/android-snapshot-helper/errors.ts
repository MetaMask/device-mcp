// Derived from agent-device (MIT, Copyright (c) 2026 Callstack)
// https://github.com/callstackincubator/agent-device/blob/336bf17af44e9be1810592d5dc42163771c3e8de/src/utils/errors.ts
// See ./vendor/NOTICE.md and ./vendor/LICENSE.MIT for attribution.

export type SnapshotHelperErrorCode = 'COMMAND_FAILED' | 'INVALID_ARGS';

export class SnapshotHelperError extends Error {
  readonly code: SnapshotHelperErrorCode;

  readonly details?: Record<string, unknown>;

  constructor(
    code: SnapshotHelperErrorCode,
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SnapshotHelperError';
    this.code = code;
    this.details = details;
  }
}
