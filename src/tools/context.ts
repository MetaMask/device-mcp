import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerContextTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_context',
    {
      title: 'Context',
      description:
        'List or switch between app contexts (NATIVE_APP, WEBVIEW_*, etc.). ' +
        'Use action=list to see available contexts, action=switch to change. ' +
        'WebView context switching requires the Appium backend.',
      inputSchema: {
        action: z
          .enum(['list', 'switch'])
          .describe('Action: list available contexts or switch to one'),
        context: z
          .string()
          .optional()
          .describe('Context name to switch to (required for action=switch)'),
      },
    },
    async ({ action, context }) => {
      try {
        if (action === 'list') {
          const contexts = await backend.getContexts();
          return {
            content: [
              {
                type: 'text' as const,
                text: `Available contexts:\n${contexts.map((c) => `  - ${c}`).join('\n')}`,
              },
            ],
          };
        }

        if (!context) {
          return errorResult(
            new Error('context is required when action is "switch"'),
          );
        }

        await backend.setContext(context);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Switched to context: ${context}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
