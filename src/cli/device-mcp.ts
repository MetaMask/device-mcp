#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createLazyBackend } from '../backends/index.js';
import { createMcpServer } from '../server.js';

async function main(): Promise<void> {
  const deviceId = process.env.DEVICE_ID;

  console.error(
    `@metamask/device-mcp starting...${deviceId ? ` (DEVICE_ID=${deviceId})` : ' (auto-detect)'}`,
  );

  const backend = createLazyBackend(deviceId);
  const server = createMcpServer(backend);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('@metamask/device-mcp ready on stdio');
}

main().catch((error: unknown) => {
  console.error('Fatal:', error);
  process.exit(1);
});
