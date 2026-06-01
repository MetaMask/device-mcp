import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { LazyDeviceBackend } from '../backends/index.js';

export function registerSelectDeviceTool(
  server: McpServer,
  backend: LazyDeviceBackend,
): void {
  server.registerTool(
    'device_select_device',
    {
      title: 'Select Device',
      description:
        'Select a device to use for this session. Call device_list_devices first to see available devices.',
      inputSchema: {
        deviceId: z
          .string()
          .describe('Device ID to select (UDID for iOS, serial for Android)'),
      },
    },
    async ({ deviceId }) => {
      try {
        backend.selectDevice(deviceId);
        const info = await backend.getDeviceInfo();

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Selected device: ${info.name}`,
                `Platform: ${info.platform}`,
                `OS: ${info.osVersion}`,
                `ID: ${info.deviceId}`,
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
