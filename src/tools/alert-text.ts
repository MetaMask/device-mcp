import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerAlertTextTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_get_alert_text',
    {
      title: 'Get Alert Text',
      description:
        'Get the text content of the currently displayed system alert or dialog. ' +
        'Call this before device_dismiss_alert to understand what the alert says.',
      inputSchema: z.object({}).shape,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const text = await backend.getAlertText();
        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
