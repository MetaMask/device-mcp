import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerTapCoordinatesTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_tap_coordinates',
    {
      title: 'Tap Coordinates',
      description:
        'Tap at exact screen coordinates. Use as a last resort when an element ' +
        'cannot be found by label/identifier/text. Get coordinates from device_snapshot frame data.',
      inputSchema: {
        x: z.number().describe('X coordinate in pixels'),
        y: z.number().describe('Y coordinate in pixels'),
      },
    },
    async ({ x, y }) => {
      try {
        await backend.tapCoordinates(x, y);
        return {
          content: [{ type: 'text' as const, text: `Tapped at (${x}, ${y})` }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
