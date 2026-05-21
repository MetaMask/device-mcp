import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerWaitForTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_wait_for',
    {
      title: 'Wait For Element',
      description:
        'Poll the UI hierarchy until an element matching the query appears. ' +
        'Useful for waiting on transitions, loading states, or navigation.',
      inputSchema: {
        label: z.string().optional().describe('Accessibility label to match'),
        identifier: z
          .string()
          .optional()
          .describe('Identifier/resource-id to match'),
        text: z.string().optional().describe('Text content to match'),
        type: z.string().optional().describe('Element type to match'),
        timeoutMs: z
          .number()
          .optional()
          .describe('Max wait time in ms (default: 10000)'),
      },
    },
    async ({ label, identifier, text, type, timeoutMs }) => {
      try {
        const element = await backend.waitForElement(
          { label, identifier, text, type },
          timeoutMs,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Found element:`,
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
