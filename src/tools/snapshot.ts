import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';
import { formatHierarchy } from '../utils/element.js';

export function registerSnapshotTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'device_snapshot',
    {
      title: 'Device Snapshot',
      description:
        'Capture the current UI hierarchy from the device. Returns all visible elements ' +
        'with their types, labels, identifiers, values, frames, and enabled state. ' +
        'Call this FIRST to see what is on screen before interacting.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const result = await backend.snapshot();
        const formatted = formatHierarchy(result.hierarchy, 0);
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Platform: ${result.platform}`,
                `Timestamp: ${new Date(result.timestamp).toISOString()}`,
                `Elements:`,
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
