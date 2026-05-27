import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerScrollToElementTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_scroll_to_element',
    {
      title: 'Scroll To Element',
      description:
        'Scroll the screen until an element matching the query becomes visible. ' +
        'Combines scrolling and element search into one atomic operation. ' +
        'Specify at least one of: label, identifier, text, type.',
      inputSchema: {
        label: z.string().optional().describe('Accessibility label to match'),
        identifier: z
          .string()
          .optional()
          .describe('Identifier/resource-id to match'),
        text: z.string().optional().describe('Text content to match'),
        type: z.string().optional().describe('Element type to match'),
        direction: z
          .enum(['up', 'down'])
          .optional()
          .describe('Scroll direction (default: down)'),
        maxAttempts: z
          .number()
          .optional()
          .describe('Maximum scroll attempts (default: 10)'),
      },
    },
    async ({ label, identifier, text, type, direction, maxAttempts }) => {
      try {
        const element = await backend.scrollToElement(
          { label, identifier, text, type },
          direction,
          maxAttempts,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Found element after scrolling:`,
                `  type: ${element.type}`,
                element.label ? `  label: "${element.label}"` : null,
                element.identifier ? `  id: "${element.identifier}"` : null,
                element.value ? `  value: "${element.value}"` : null,
                `  frame: (${element.frame.x}, ${element.frame.y}) ${element.frame.width}x${element.frame.height}`,
                `  enabled: ${element.enabled}`,
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
