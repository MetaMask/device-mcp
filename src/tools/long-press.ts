import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerLongPressTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_long_press',
    {
      title: 'Long Press',
      description:
        'Long press an element. Used for context menus, drag initiation, ' +
        'and other long-press interactions. Default duration is 1000ms.',
      inputSchema: {
        label: z.string().optional().describe('Accessibility label'),
        identifier: z.string().optional().describe('Identifier/resource-id'),
        text: z.string().optional().describe('Text content'),
        type: z.string().optional().describe('Element type'),
        durationMs: z
          .number()
          .optional()
          .describe('Press duration in ms (default: 1000)'),
      },
    },
    async ({ label, identifier, text, type, durationMs }) => {
      try {
        const result = await backend.longPress(
          { label, identifier, text, type },
          durationMs,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `Long pressed ${result.targetDescription} at (${result.x}, ${result.y}) for ${durationMs ?? 1000}ms`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
