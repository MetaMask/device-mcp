import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerScreenshotTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_screenshot',
    {
      title: 'Screenshot',
      description:
        'Capture a screenshot of the current device screen. ' +
        'Returns base64-encoded PNG data. Optionally saves to a file path.',
      inputSchema: {
        outputPath: z
          .string()
          .optional()
          .describe('File path to save the screenshot (optional)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ outputPath }) => {
      try {
        const result = await backend.screenshot(outputPath);
        return {
          content: [
            {
              type: 'image' as const,
              data: result.data,
              mimeType: `image/${result.format}`,
            },
            {
              type: 'text' as const,
              text: result.path
                ? `Screenshot saved to ${result.path}`
                : 'Screenshot captured',
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
