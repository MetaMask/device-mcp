import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerDismissAlertTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_dismiss_alert',
    {
      title: 'Dismiss Alert',
      description:
        'Accept or dismiss a system alert or permission dialog. ' +
        'Use accept=true for "Allow"/"OK", accept=false for "Deny"/"Cancel". ' +
        'Check device_snapshot first to confirm an alert is present.',
      inputSchema: {
        accept: z
          .boolean()
          .describe(
            'true to accept (Allow/OK), false to dismiss (Deny/Cancel)',
          ),
      },
    },
    async ({ accept }) => {
      try {
        await backend.dismissAlert(accept);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Alert ${accept ? 'accepted' : 'dismissed'}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
