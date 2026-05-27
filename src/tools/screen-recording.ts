import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerScreenRecordingTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_screen_recording',
    {
      title: 'Screen Recording',
      description:
        'Start or stop recording the device screen as an MP4 video. ' +
        'Call with action=start to begin, action=stop to end and save. ' +
        'Returns the file path on stop.',
      inputSchema: {
        action: z
          .enum(['start', 'stop'])
          .describe('Action: start or stop recording'),
        outputPath: z
          .string()
          .optional()
          .describe('File path to save the recording (optional, for start)'),
      },
    },
    async ({ action, outputPath }) => {
      try {
        if (action === 'start') {
          await backend.startScreenRecording(outputPath);
          return {
            content: [
              { type: 'text' as const, text: 'Screen recording started' },
            ],
          };
        }

        const path = await backend.stopScreenRecording();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Screen recording saved to ${path}`,
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
