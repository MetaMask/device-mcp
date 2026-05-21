import { execFile, ExecFileOptions } from 'node:child_process';

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Execute a command and return stdout/stderr/exitCode.
 * Rejects only on spawn failure — non-zero exit codes are returned, not thrown.
 *
 * @param command - The command to execute.
 * @param args - Arguments to pass to the command.
 * @param options - Execution options including timeoutMs.
 * @returns The stdout, stderr, and exit code.
 */
export async function exec(
  command: string,
  args: string[],
  options?: ExecFileOptions & { timeoutMs?: number },
): Promise<ExecResult> {
  const { timeoutMs = 30_000, ...execOptions } = options ?? {};

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        ...execOptions,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB — UI hierarchies can be large
      },
      (error, stdout, stderr) => {
        if (error && !('code' in error)) {
          // Spawn failure (command not found, ENOENT, etc.)
          reject(new Error(error.message));
          return;
        }
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          exitCode: (error as NodeJS.ErrnoException)?.code
            ? 1
            : (child.exitCode ?? 0),
        });
      },
    );
  });
}

export async function execStrict(
  command: string,
  args: string[],
  options?: ExecFileOptions & { timeoutMs?: number },
): Promise<string> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n` +
        `Exit code: ${result.exitCode}\n` +
        `stderr: ${result.stderr}`,
    );
  }
  return result.stdout;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await exec('which', [command], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}
