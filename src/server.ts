import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DeviceBackend } from './backends/types.js';
import {
  registerSnapshotTool,
  registerScreenshotTool,
  registerTapElementTool,
  registerTapCoordinatesTool,
  registerTypeTool,
  registerSwipeTool,
  registerLongPressTool,
  registerWaitForTool,
  registerAppStateTool,
  registerDeviceInfoTool,
  registerOpenAppTool,
  registerCloseAppTool,
  registerPressButtonTool,
  registerDismissKeyboardTool,
  registerDismissAlertTool,
  registerLogsTool,
} from './tools/index.js';

export function createMcpServer(backend: DeviceBackend): McpServer {
  const server = new McpServer(
    { name: '@metamask/device-mcp', version: '0.1.0' },
    {
      instructions: [
        'Mobile device interaction tools for iOS (IDB) and Android (ADB).',
        'ALWAYS call device_snapshot before device_tap_element to see the current screen.',
        'Never call device_snapshot twice without acting in between.',
        'Elements are identified by accessibility label, resource-id, content-description, or text.',
        'Element matching is fuzzy: partial text and case-insensitive matches work.',
        'After typing, call device_dismiss_keyboard to reveal elements obscured by the keyboard.',
        'Check for system alerts with device_snapshot before interacting with app elements.',
      ].join('\n'),
    },
  );

  registerSnapshotTool(server, backend);
  registerScreenshotTool(server, backend);
  registerDeviceInfoTool(server, backend);
  registerTapElementTool(server, backend);
  registerTapCoordinatesTool(server, backend);
  registerTypeTool(server, backend);
  registerSwipeTool(server, backend);
  registerLongPressTool(server, backend);
  registerWaitForTool(server, backend);
  registerAppStateTool(server, backend);
  registerOpenAppTool(server, backend);
  registerCloseAppTool(server, backend);
  registerPressButtonTool(server, backend);
  registerDismissKeyboardTool(server, backend);
  registerDismissAlertTool(server, backend);
  registerLogsTool(server, backend);

  return server;
}
