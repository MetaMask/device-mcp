import { randomBytes } from 'node:crypto';
import { chmodSync, constants as fsConstants, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** Kinds of on-disk device artifact and their file extension. */
const ARTIFACT_EXTENSION = {
  screenshot: 'png',
  recording: 'mp4',
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_EXTENSION;

/** Owner read/write only — device artifacts may contain sensitive UI (seed phrases, keys, balances). */
const ARTIFACT_MODE = 0o600;

/**
 * Open flags for writing an artifact: create/truncate, write-only, and
 * `O_NOFOLLOW` so a pre-planted symlink at the destination is never followed
 * (defeats `/tmp` symlink / TOCTOU attacks). `O_NOFOLLOW` is a no-op on
 * platforms that do not define it.
 */
/* eslint-disable no-bitwise -- POSIX open(2) flags are combined with bitwise OR */
const ARTIFACT_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  fsConstants.O_CREAT |
  fsConstants.O_TRUNC |
  (fsConstants.O_NOFOLLOW ?? 0);
/* eslint-enable no-bitwise */

let sessionTempDir: string | null = null;

/**
 * Lazily create (once per process) a private temporary directory with
 * owner-only permissions (`0700`) to hold default artifacts. Because the
 * directory itself is unreadable to other users, files placed inside it are
 * protected even when written by an external tool (idb/adb) that we cannot
 * pass secure open flags to.
 *
 * @returns The absolute path to the per-process private temp directory.
 */
function getSessionTempDir(): string {
  if (!sessionTempDir) {
    sessionTempDir = mkdtempSync(join(tmpdir(), 'device-mcp-'));
  }
  return sessionTempDir;
}

/**
 * Resolve the optional output-directory allowlist from the environment.
 *
 * @returns The absolute allowed base directory, or `null` when unrestricted.
 */
function allowedBaseDir(): string | null {
  const configured = process.env.DEVICE_MCP_OUTPUT_DIR?.trim();
  return configured ? resolve(configured) : null;
}

/**
 * Reject a caller-supplied path that escapes `DEVICE_MCP_OUTPUT_DIR` when that
 * sandbox is configured. No-op when the env var is unset.
 *
 * @param target - The already-resolved absolute destination path.
 */
function assertWithinAllowedBase(target: string): void {
  const base = allowedBaseDir();
  if (!base) {
    return;
  }
  const rel = relative(base, target);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `Refusing to write outside DEVICE_MCP_OUTPUT_DIR (${base}): ${target}`,
    );
  }
}

/**
 * Compute a safe absolute path for a device artifact.
 *
 * - When no `outputPath` is given, returns an unpredictable file name inside a
 *   private per-process temp directory. This replaces the previous predictable
 *   `/tmp/device-mcp-*-${Date.now()}` names, which were vulnerable to symlink
 *   and information-disclosure attacks in the shared temp directory.
 * - When an `outputPath` is given, it is rejected if it contains a NUL byte,
 *   resolved to an absolute path, and — when `DEVICE_MCP_OUTPUT_DIR` is set —
 *   confined to that directory.
 *
 * @param outputPath - Optional caller-supplied destination path.
 * @param kind - The artifact kind, used to pick the default file extension.
 * @returns The resolved, validated absolute path to write to.
 */
export function resolveArtifactPath(
  outputPath: string | undefined,
  kind: ArtifactKind,
): string {
  if (outputPath === undefined) {
    const token = randomBytes(8).toString('hex');
    return join(
      getSessionTempDir(),
      `${kind}-${token}.${ARTIFACT_EXTENSION[kind]}`,
    );
  }

  if (outputPath.includes('\0')) {
    throw new Error('Invalid output path: contains a NUL byte');
  }

  const target = resolve(outputPath);
  assertWithinAllowedBase(target);
  return target;
}

/**
 * Write bytes to an artifact path with hardened permissions and open flags:
 * owner-only (`0600`) and `O_NOFOLLOW`. Use for artifacts we write directly
 * in-process (e.g. the Appium backend decoding a base64 screenshot).
 *
 * @param path - The destination path (should come from `resolveArtifactPath`).
 * @param data - The bytes to write.
 */
export async function writeArtifactFile(
  path: string,
  data: Buffer,
): Promise<void> {
  await writeFile(path, data, {
    mode: ARTIFACT_MODE,
    flag: ARTIFACT_WRITE_FLAGS,
  });
}

/**
 * Best-effort tightening of permissions on a file written by an external tool
 * (idb/adb create the file themselves, so we cannot pass secure open flags).
 * Silently ignored when unsupported or when the file is absent.
 *
 * @param path - The path of the file to restrict to owner-only access.
 */
export function hardenArtifactFile(path: string): void {
  try {
    chmodSync(path, ARTIFACT_MODE);
  } catch {
    // Best-effort: the filesystem may not support chmod (e.g. some mounts on
    // Windows) or the external tool may have failed to create the file.
  }
}
