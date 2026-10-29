#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createLazyBackend } from '../backends/index.js';
import type { Platform } from '../backends/types.js';
import { createMcpServer } from '../server.js';

async function main(): Promise<void> {
  const deviceId = process.env.DEVICE_ID;
  const devicePlatform = process.env.DEVICE_PLATFORM as Platform | undefined;

  const parts: string[] = [];
  if (deviceId) {
    parts.push(`DEVICE_ID=${deviceId}`);
  }
  if (devicePlatform) {
    parts.push(`DEVICE_PLATFORM=${devicePlatform}`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ' (auto-detect)';
  console.error(`@metamask/device-mcp starting...${suffix}`);

  const backend = createLazyBackend(deviceId, devicePlatform);
  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();
  let stopping: Promise<void> | undefined;
  const shutdown = async (): Promise<void> => {
    stopping ??= (async (): Promise<void> => {
      try {
        await backend.dispose?.();
      } finally {
        await server.close();
      }
    })();
    return stopping;
  };
  server.server.onclose = (): void => {
    backend
      .dispose?.()
      .catch((error: unknown) => console.error('Cleanup failed:', error));
  };
  const exit = (): void => {
    shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('Cleanup failed:', error);
        process.exit(1);
      });
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, exit);
  }
  // The SDK stdio transport does not turn stdin EOF into an onclose callback.
  process.stdin.once('end', exit);
  try {
    await server.connect(transport);
  } catch (error) {
    await shutdown();
    throw error;
  }

  console.error('@metamask/device-mcp ready on stdio');
}

main().catch((error: unknown) => {
  console.error('Fatal:', error);
  process.exit(1);
});
