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
        'Swipe until an element matching the query is inside the viewport ' +
        '(being in the UI tree is not enough), and report how many swipes ' +
        'it took. Fails when the element is not in view after maxAttempts ' +
        'swipes or the screen stops moving. ' +
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
          .enum(['auto', 'up', 'down'])
          .optional()
          .describe(
            'Finger direction: "up" reveals content below, "down" content ' +
              'above. Default "auto": from where the element is, searching ' +
              'downward first when it is not in the UI tree yet.',
          ),
        maxAttempts: z
          .number()
          .optional()
          .describe('Maximum number of swipes (default: 10)'),
      },
    },
    async ({ label, identifier, text, type, direction, maxAttempts }) => {
      try {
        const { element, swipes } = await backend.scrollToElement(
          { label, identifier, text, type },
          direction,
          maxAttempts,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Element in viewport after ${swipes} swipe(s):`,
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
