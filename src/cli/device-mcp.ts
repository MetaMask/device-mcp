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
  await server.connect(transport);

  console.error('@metamask/device-mcp ready on stdio');
}

main().catch((error: unknown) => {
  console.error('Fatal:', error);
  process.exit(1);
});
