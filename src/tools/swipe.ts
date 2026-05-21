import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerSwipeTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_swipe',
    {
      title: 'Swipe',
      description:
        'Swipe on the device screen. Use natural scrolling: swipe "up" to scroll down. ' +
        'Optionally specify start coordinates and distance.',
      inputSchema: {
        direction: z
          .enum(['up', 'down', 'left', 'right'])
          .describe('Swipe direction'),
        startX: z.number().optional().describe('Start X coordinate'),
        startY: z.number().optional().describe('Start Y coordinate'),
        distance: z
          .number()
          .optional()
          .describe('Swipe distance in pixels (default: 500)'),
      },
    },
    async ({ direction, startX, startY, distance }) => {
      try {
        await backend.swipe(direction, startX, startY, distance);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Swiped ${direction}${startX === undefined ? '' : ` from (${startX}, ${startY})`}${distance === undefined ? '' : ` distance=${distance}px`}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
