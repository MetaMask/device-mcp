import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { LazyDeviceBackend } from './backends/index.js';
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
  registerScrollToElementTool,
  registerAlertTextTool,
  registerWindowSizeTool,
  registerContextTool,
  registerClipboardTool,
  registerScreenRecordingTool,
  registerGenerateLocatorsTool,
  registerGetElementTextTool,
  registerListDevicesTool,
  registerSelectDeviceTool,
} from './tools/index.js';

export function createMcpServer(backend: LazyDeviceBackend): McpServer {
  const server = new McpServer(
    { name: '@metamask/device-mcp', version: '0.0.0' },
    {
      instructions: [
        'Mobile device interaction tools for iOS (IDB) and Android (ADB).',
        'ALWAYS call device_snapshot before device_tap_element to see the current screen.',
        'Never call device_snapshot twice without acting in between.',
        'Elements are identified by accessibility label, resource-id, content-description, or text.',
        'Element matching is fuzzy: partial text and case-insensitive matches work.',
        'After typing, call device_dismiss_keyboard to reveal elements obscured by the keyboard.',
        'Check for system alerts with device_snapshot before interacting with app elements.',
        'If multiple devices are connected and no device is selected, tools will return the device list.',
        'Call device_list_devices to see available devices, then device_select_device to choose one.',
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
  registerScrollToElementTool(server, backend);
  registerAlertTextTool(server, backend);
  registerWindowSizeTool(server, backend);
  registerContextTool(server, backend);
  registerClipboardTool(server, backend);
  registerScreenRecordingTool(server, backend);
  registerGenerateLocatorsTool(server, backend);
  registerGetElementTextTool(server, backend);
  registerListDevicesTool(server, backend);
  registerSelectDeviceTool(server, backend);

  return server;
}
