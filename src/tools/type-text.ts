import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerTypeTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_type',
    {
      title: 'Type Text',
      description:
        'Type text into the currently focused input field. ' +
        'Tap an input element first to focus it, then call this.',
      inputSchema: {
        text: z.string().describe('Text to type'),
      },
    },
    async ({ text }) => {
      try {
        await backend.typeText(text);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Typed "${text}" (${text.length} characters)`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
