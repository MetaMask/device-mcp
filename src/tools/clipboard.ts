import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerClipboardTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_clipboard',
    {
      title: 'Clipboard',
      description:
        'Read or write the device clipboard. ' +
        'Use action=get to read clipboard text, action=set to write. ' +
        'On Android, clipboard access requires the Appium backend.',
      inputSchema: {
        action: z
          .enum(['get', 'set'])
          .describe('Action: get clipboard content or set it'),
        text: z
          .string()
          .optional()
          .describe('Text to set on the clipboard (required for action=set)'),
      },
    },
    async ({ action, text }) => {
      try {
        if (action === 'get') {
          const content = await backend.getClipboard();
          return {
            content: [{ type: 'text' as const, text: content }],
          };
        }

        if (!text) {
          return errorResult(
            new Error('text is required when action is "set"'),
          );
        }

        await backend.setClipboard(text);
        return {
          content: [{ type: 'text' as const, text: 'Clipboard updated' }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
