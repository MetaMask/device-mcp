/**
 * Device-scoped ADB executor used by the snapshot-helper trust + install
 * modules. Wrapping `exec('adb', ['-s', serial, ...])` behind a small function
 * keeps the serial in one place and lets those modules be unit-tested with an
 * injected fake executor instead of spawning real `adb`.
 *
 * The executor abstraction is adapted from agent-device (MIT, Copyright (c)
 * Callstack); our `ExecResult` already matches its result shape.
 */

import { exec } from '../../utils/exec.js';
import type { ExecResult } from '../../utils/exec.js';

export type AndroidAdbExecOptions = {
  timeoutMs?: number;
  maxBuffer?: number;
};

export type AndroidAdbExecutor = (
  args: string[],
  options?: AndroidAdbExecOptions,
) => Promise<ExecResult>;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Create an ADB executor bound to a single device serial. Every call is
 * prefixed with `-s <serial>` so callers pass only the sub-command.
 *
 * @param serial - The target device serial.
 * @returns An executor that runs `adb -s <serial> <args...>`.
 */
export function createAndroidAdbExecutor(serial: string): AndroidAdbExecutor {
  return async (args, options) =>
    exec('adb', ['-s', serial, ...args], {
      timeoutMs: options?.timeoutMs,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });
}
