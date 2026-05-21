import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerAppStateTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_app_state',
    {
      title: 'App State',
      description:
        'Get the current state of an app by bundle ID. ' +
        'Returns whether the app is running, installed, or not found.',
      inputSchema: {
        bundleId: z
          .string()
          .describe('App bundle ID (e.g. io.metamask or io.metamask.debug)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ bundleId }) => {
      try {
        const result = await backend.getAppState(bundleId);
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Bundle: ${result.bundleId}`,
                `State: ${result.state}`,
                result.pid ? `PID: ${result.pid}` : null,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
