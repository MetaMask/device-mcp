import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

export function registerDeviceInfoTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_info',
    {
      title: 'Device Info',
      description:
        'Get information about the connected device: platform, name, OS version, device ID.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const info = await backend.getDeviceInfo();
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Platform: ${info.platform}`,
                `Device: ${info.name}`,
                `OS: ${info.osVersion}`,
                `ID: ${info.deviceId}`,
                `State: ${info.state}`,
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
