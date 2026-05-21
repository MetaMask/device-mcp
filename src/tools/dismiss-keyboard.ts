import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerDismissKeyboardTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_dismiss_keyboard',
    {
      title: 'Dismiss Keyboard',
      description:
        'Hide the on-screen keyboard. Call after typing to reveal elements ' +
        'that may be obscured by the keyboard.',
      inputSchema: {},
    },
    async () => {
      try {
        await backend.dismissKeyboard();
        return {
          content: [{ type: 'text' as const, text: 'Keyboard dismissed' }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
