import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerCloseAppTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_close_app',
    {
      title: 'Close App',
      description:
        'Force-stop an app by bundle ID. The app process is terminated.',
      inputSchema: {
        bundleId: z.string().describe('App bundle ID or package name'),
      },
    },
    async ({ bundleId }) => {
      try {
        await backend.closeApp(bundleId);
        return {
          content: [{ type: 'text' as const, text: `Closed app: ${bundleId}` }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
