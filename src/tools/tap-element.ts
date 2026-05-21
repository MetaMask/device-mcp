import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerTapElementTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_tap_element',
    {
      title: 'Tap Element',
      description:
        'Find an element in the UI hierarchy by query and tap its center. ' +
        'Specify at least one of: label, identifier, text, type. ' +
        'Call device_snapshot first to see available elements.',
      inputSchema: {
        label: z
          .string()
          .optional()
          .describe(
            'Accessibility label (iOS) or content-description (Android)',
          ),
        identifier: z
          .string()
          .optional()
          .describe('Accessibility identifier (iOS) or resource-id (Android)'),
        text: z.string().optional().describe('Visible text content'),
        type: z.string().optional().describe('Element type/class name'),
      },
    },
    async ({ label, identifier, text, type }) => {
      try {
        const result = await backend.tapElement({
          label,
          identifier,
          text,
          type,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tapped ${result.targetDescription} at (${result.x}, ${result.y})`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
