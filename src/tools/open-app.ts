import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerOpenAppTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_open_app',
    {
      title: 'Open App',
      description:
        'Launch or bring to foreground an app by bundle ID. ' +
        'iOS: bundle ID (e.g. io.metamask). Android: package name (e.g. io.metamask).',
      inputSchema: {
        bundleId: z.string().describe('App bundle ID or package name'),
      },
    },
    async ({ bundleId }) => {
      try {
        await backend.openApp(bundleId);
        return {
          content: [{ type: 'text' as const, text: `Opened app: ${bundleId}` }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
