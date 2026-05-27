import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerWindowSizeTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_get_window_size',
    {
      title: 'Get Window Size',
      description:
        'Get the width and height of the device screen in pixels (Android) or points (iOS).',
      inputSchema: z.object({}).shape,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const size = await backend.getWindowSize();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Width: ${size.width}, Height: ${size.height}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
