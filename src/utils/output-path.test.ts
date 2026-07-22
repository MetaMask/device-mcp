/* eslint-disable n/no-process-env -- these tests toggle DEVICE_MCP_OUTPUT_DIR to exercise the output sandbox */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import {
  hardenArtifactFile,
  resolveArtifactPath,
  writeArtifactFile,
} from './output-path.js';

const isWindows = process.platform === 'win32';

const permsOf = (path: string): string =>
  statSync(path).mode.toString(8).slice(-3);

describe('resolveArtifactPath', () => {
  const originalOutputDir = process.env.DEVICE_MCP_OUTPUT_DIR;

  afterEach(() => {
    if (originalOutputDir === undefined) {
      delete process.env.DEVICE_MCP_OUTPUT_DIR;
    } else {
      process.env.DEVICE_MCP_OUTPUT_DIR = originalOutputDir;
    }
  });

  it('generates an unpredictable name in a private temp dir by default', () => {
    delete process.env.DEVICE_MCP_OUTPUT_DIR;

    const path = resolveArtifactPath(undefined, 'screenshot');

    expect(isAbsolute(path)).toBe(true);
    expect(path).toMatch(
      /[/\\]device-mcp-[^/\\]+[/\\]screenshot-[0-9a-f]{16}\.png$/u,
    );
  });

  it('uses the mp4 extension for recordings', () => {
    delete process.env.DEVICE_MCP_OUTPUT_DIR;

    const path = resolveArtifactPath(undefined, 'recording');

    expect(path).toMatch(
      /[/\\]device-mcp-[^/\\]+[/\\]recording-[0-9a-f]{16}\.mp4$/u,
    );
  });

  it('reuses one private temp dir but never repeats a file name', () => {
    delete process.env.DEVICE_MCP_OUTPUT_DIR;

    const first = resolveArtifactPath(undefined, 'screenshot');
    const second = resolveArtifactPath(undefined, 'screenshot');

    expect(dirname(first)).toBe(dirname(second));
    expect(first).not.toBe(second);
  });

  it('resolves a caller path to an absolute path', () => {
    delete process.env.DEVICE_MCP_OUTPUT_DIR;

    expect(resolveArtifactPath('shots/a.png', 'screenshot')).toBe(
      resolve('shots/a.png'),
    );
    expect(resolveArtifactPath('/tmp/a.png', 'screenshot')).toBe(
      resolve('/tmp/a.png'),
    );
  });

  it('rejects a path containing a NUL byte', () => {
    delete process.env.DEVICE_MCP_OUTPUT_DIR;

    expect(() => resolveArtifactPath('a\0b.png', 'screenshot')).toThrow(
      'NUL byte',
    );
  });

  it('allows a caller path inside DEVICE_MCP_OUTPUT_DIR', () => {
    const base = mkdtempSync(join(tmpdir(), 'device-mcp-sandbox-'));
    process.env.DEVICE_MCP_OUTPUT_DIR = base;

    try {
      const path = resolveArtifactPath(
        join(base, 'nested', 'a.png'),
        'screenshot',
      );
      expect(path).toBe(resolve(base, 'nested', 'a.png'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('rejects a caller path that escapes DEVICE_MCP_OUTPUT_DIR', () => {
    const base = mkdtempSync(join(tmpdir(), 'device-mcp-sandbox-'));
    process.env.DEVICE_MCP_OUTPUT_DIR = base;

    try {
      expect(() =>
        resolveArtifactPath(join(base, '..', 'escape.png'), 'screenshot'),
      ).toThrow('DEVICE_MCP_OUTPUT_DIR');
      expect(() => resolveArtifactPath('/etc/passwd', 'screenshot')).toThrow(
        'DEVICE_MCP_OUTPUT_DIR',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('writeArtifactFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-mcp-write-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the given bytes to the destination', async () => {
    const path = join(dir, 'shot.png');

    await writeArtifactFile(path, Buffer.from('image-bytes'));

    expect(readFileSync(path).toString()).toBe('image-bytes');
  });

  it.skipIf(isWindows)('writes with owner-only permissions', async () => {
    const path = join(dir, 'shot.png');

    await writeArtifactFile(path, Buffer.from('image-bytes'));

    expect(permsOf(path)).toBe('600');
  });

  it.skipIf(isWindows)(
    'refuses to follow a symlink at the destination',
    async () => {
      const outside = join(dir, 'outside.txt');
      writeFileSync(outside, 'original');
      symlinkSync(outside, join(dir, 'link.png'));

      await expect(
        writeArtifactFile(join(dir, 'link.png'), Buffer.from('attacker')),
      ).rejects.toThrow('ELOOP');
      expect(readFileSync(outside).toString()).toBe('original');
    },
  );
});

describe('hardenArtifactFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-mcp-harden-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(isWindows)(
    'restricts an existing file to owner-only access',
    () => {
      const path = join(dir, 'shot.png');
      writeFileSync(path, 'data');
      chmodSync(path, 0o644);

      hardenArtifactFile(path);

      expect(permsOf(path)).toBe('600');
    },
  );

  it('does not throw when the file is absent', () => {
    expect(() => hardenArtifactFile(join(dir, 'missing.png'))).not.toThrow();
  });
});
