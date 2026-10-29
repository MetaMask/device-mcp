import type { ChildProcess } from 'node:child_process';

const STOP_TIMEOUT_MS = 5_000;

/**
 * Stop an owned child and wait for exit, escalating only that child if needed.
 *
 * @param child - The process created by this session.
 * @param signal - The initial graceful-stop signal.
 */
export async function stopChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<void> {
  if (
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid === undefined
  ) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let escalated = false;
    const timer = setInterval(() => {
      if (escalated) {
        onError(new Error('Timed out stopping owned child process'));
        return;
      }
      // Never look up or kill arbitrary PIDs or process groups.
      child.kill('SIGKILL');
      escalated = true;
    }, STOP_TIMEOUT_MS);
    function onError(error: Error): void {
      clearInterval(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      reject(error);
    }
    function onExit(): void {
      clearInterval(timer);
      child.off('error', onError);
      resolve();
    }
    child.once('exit', onExit);
    child.once('error', onError);
    child.kill(signal);
  });
}
