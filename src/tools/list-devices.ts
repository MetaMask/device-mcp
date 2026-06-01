import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { errorResult } from './shared.js';
import type { LazyDeviceBackend } from '../backends/index.js';

export function registerListDevicesTool(
  server: McpServer,
  backend: LazyDeviceBackend,
): void {
  server.registerTool(
    'device_list_devices',
    {
      title: 'List Devices',
      description: 'List all connected devices and simulators/emulators.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const devices = await backend.listDevices();

        if (devices.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No connected devices found. Boot a simulator/emulator or connect a device.',
              },
            ],
          };
        }

        const header = 'Platform\tDevice ID';
        const rows = devices.map((d) => `${d.platform}\t${d.deviceId}`);
        const text = [header, ...rows].join('\n');

        return {
          content: [{ type: 'text' as const, text }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
