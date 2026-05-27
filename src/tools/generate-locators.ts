import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';
import { generateLocators, formatLocators } from '../utils/element.js';

export function registerGenerateLocatorsTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_generate_locators',
    {
      title: 'Generate Locators',
      description:
        'Generate ranked locator suggestions for all interactive elements on the current screen. ' +
        'Each element gets a prioritized list: identifier (testID/resource-id) > label > text > type. ' +
        'Use this after healing to find the correct selector for updating test source code.',
      inputSchema: z.object({}).shape,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const snapshot = await backend.snapshot();
        const locators = generateLocators(snapshot.hierarchy);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Found ${locators.length} interactive elements on ${snapshot.platform}:\n\n${formatLocators(locators)}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
