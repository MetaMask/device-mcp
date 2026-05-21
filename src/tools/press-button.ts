import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerPressButtonTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_press_button',
    {
      title: 'Press Button',
      description:
        'Press a physical device button. ' +
        'Note: iOS has no back button — "back" maps to home.',
      inputSchema: {
        button: z
          .enum(['home', 'back', 'enter', 'lock'])
          .describe('Button to press'),
      },
    },
    async ({ button }) => {
      try {
        await backend.pressButton(button);
        return {
          content: [
            { type: 'text' as const, text: `Pressed ${button} button` },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
