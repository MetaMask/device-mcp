import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerLogsTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_logs',
    {
      title: 'Device Logs',
      description:
        'Capture recent device logs. iOS: system log via IDB. ' +
        'Android: logcat. Optionally filter by text pattern.',
      inputSchema: {
        durationSeconds: z
          .number()
          .optional()
          .describe('How many seconds of logs to retrieve (default: 30)'),
        filter: z
          .string()
          .optional()
          .describe('Text pattern to filter log entries'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ durationSeconds, filter }) => {
      try {
        const result = await backend.getLogs(durationSeconds, filter);
        const formatted = result.entries
          .slice(-100)
          .map(
            (entry) => `[${entry.timestamp}] ${entry.level}: ${entry.message}`,
          )
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Source: ${result.source}`,
                `Entries: ${result.entries.length}${result.entries.length > 100 ? ' (showing last 100)' : ''}`,
                '',
                formatted,
              ].join('\n'),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
