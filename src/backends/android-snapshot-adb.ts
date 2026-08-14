import type { AndroidAdbExecutor } from './android-snapshot-helper/index.js';
import { exec } from '../utils/exec.js';

export function createAndroidSnapshotAdbExecutor(
  serial: string,
): AndroidAdbExecutor {
  return async (args, options = {}) => {
    const result = await exec('adb', ['-s', serial, ...args], {
      timeoutMs: options.timeoutMs,
    });
    if (!options.allowFailure && result.exitCode !== 0) {
      throw new Error(
        `adb -s ${serial} ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return result;
  };
}
