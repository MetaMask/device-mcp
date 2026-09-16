import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Registers the `webview_cdp` MCP tool, which speaks raw Chrome DevTools
 * Protocol (CDP) to a debuggable in-app Android `WebView` (the web page inside
 * an app's in-app browser) over adb.
 *
 * This is distinct from `hermes_cdp`: Hermes targets the React Native JS engine
 * (no DOM), whereas this targets the Chromium page and exposes the full Chrome
 * surface (Runtime, DOM, Page, Network, Input). Android only \u2014 the backend must
 * expose the optional `webviewCdp` capability, and the app must have called
 * `WebView.setWebContentsDebuggingEnabled(true)`.
 *
 * @param server - The MCP server to register the tool on.
 * @param backend - The device backend; only Android (adb) exposes `webviewCdp`.
 */
export function registerWebViewCdpTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'webview_cdp',
    {
      title: 'WebView CDP',
      description:
        'Speak raw Chrome DevTools Protocol (CDP) to a debuggable in-app ' +
        'Android WebView \u2014 the web page inside the app\u2019s in-app browser. ' +
        'Unlike hermes_cdp (React Native JS engine, no DOM), this targets the ' +
        'Chromium page and exposes the full Chrome surface (Runtime, DOM, Page, ' +
        'Network, Input). Android only; the app must call ' +
        'WebView.setWebContentsDebuggingEnabled(true). Blocked methods (for ' +
        'safety): Browser.close, Target.closeTarget, ' +
        'Target.disposeBrowserContext, Browser.crashGpuProcess. Node 20 must be ' +
        'launched with NODE_OPTIONS="--experimental-websocket" (Node 22+ works ' +
        'out of the box). Example: method "Runtime.evaluate" with params ' +
        '{"expression":"document.querySelector(\'#submit\').click()"}.',
      inputSchema: {
        method: z
          .string()
          .describe('The CDP method to invoke, e.g. "Runtime.evaluate".'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Optional CDP method parameters.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Timeout in milliseconds for discovery and each CDP round-trip ` +
              `(default ${DEFAULT_TIMEOUT_MS}, floored to ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
          ),
        urlFilter: z
          .string()
          .optional()
          .describe(
            'Select the WebView page whose URL contains this substring when ' +
              'several WebView pages are open.',
          ),
      },
    },
    async ({ method, params, timeoutMs, urlFilter }) => {
      try {
        if (!backend.webviewCdp) {
          return errorResult(
            new Error(
              'webview_cdp is only available on an Android (adb) session with ' +
                'a debuggable in-app WebView.',
            ),
          );
        }

        const clampedTimeoutMs = Math.min(
          Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        );

        const result = await backend.webviewCdp({
          method,
          params,
          timeoutMs: clampedTimeoutMs,
          urlFilter,
        });

        if (!result.ok) {
          return errorResult(new Error(`[${result.code}] ${result.message}`));
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.result, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
