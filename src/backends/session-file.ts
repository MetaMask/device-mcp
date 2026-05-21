import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Platform } from './types.js';

export type SessionConfig = AttachSessionConfig | CreateSessionConfig;

export type AttachSessionConfig = {
  mode: 'attach';
  appiumUrl: string;
  sessionId: string;
  platform: Platform;
  auth?: {
    user: string;
    key: string;
  };
};

export type CreateSessionConfig = {
  mode: 'create';
  appiumUrl: string;
  platform: Platform;
  capabilities: Record<string, unknown>;
  auth?: {
    user: string;
    key: string;
  };
};

const SESSION_FILE_NAME = '.device-session';

export async function readSessionFile(
  searchDir?: string,
): Promise<SessionConfig | null> {
  const dir = searchDir ?? process.cwd();
  const filePath = resolve(dir, SESSION_FILE_NAME);

  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return validateSessionConfig(parsed);
  } catch {
    return null;
  }
}

function validateSessionConfig(raw: Record<string, unknown>): SessionConfig {
  const appiumUrl = requireString(raw, 'appiumUrl');
  const platform = requirePlatform(raw);

  const auth =
    raw.auth && typeof raw.auth === 'object'
      ? {
          user: requireString(raw.auth as Record<string, unknown>, 'user'),
          key: requireString(raw.auth as Record<string, unknown>, 'key'),
        }
      : undefined;

  if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) {
    return {
      mode: 'attach',
      appiumUrl,
      sessionId: raw.sessionId,
      platform,
      auth,
    };
  }

  if (raw.capabilities && typeof raw.capabilities === 'object') {
    return {
      mode: 'create',
      appiumUrl,
      platform,
      capabilities: raw.capabilities as Record<string, unknown>,
      auth,
    };
  }

  throw new Error(
    '.device-session must contain either "sessionId" (attach) or "capabilities" (create)',
  );
}

function requireString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`.device-session: "${field}" must be a non-empty string`);
  }
  return value;
}

function requirePlatform(obj: Record<string, unknown>): Platform {
  const value = obj.platform;
  if (value !== 'ios' && value !== 'android') {
    throw new Error('.device-session: "platform" must be "ios" or "android"');
  }
  return value;
}
