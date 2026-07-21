import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';
import { runHermesCdp } from '../hermes/hermes-cdp.js';
import { getHermesSession } from '../hermes/session.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Registers the `hermes_cdp` MCP tool, which speaks raw Chrome DevTools
 * Protocol (CDP) to the React Native Hermes runtime of a running app via
 * Metro's inspector proxy (iOS and Android).
 *
 * The handler is intentionally THIN: it resolves the Metro port/appId and the
 * current device pin from {@link getHermesSession}, delegates ALL discovery,
 * verification, and execution logic to {@link runHermesCdp}, and persists the
 * resolved pin via the core's `onPin` callback.
 *
 * @param server - The MCP server to register the tool on.
 * @param backend - The lazy device backend, used at call time only to read the
 * live platform so the session can resolve the correct default app bundle ID.
 */
export function registerHermesCdpTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'hermes_cdp',
    {
      title: 'Hermes CDP',
      description:
        'Speak raw Chrome DevTools Protocol (CDP) to the React Native Hermes ' +
        'JS runtime of a running app via Metro\u2019s inspector proxy (iOS and ' +
        'Android). Requires a DEBUG build with Metro running; release builds ' +
        'expose no inspector. Blocked methods (for safety): ' +
        'Runtime.terminateExecution, Inspector.detached. Node 20 must be ' +
        'launched with NODE_OPTIONS="--experimental-websocket" (Node 22+ works ' +
        'out of the box). Example: method "Runtime.evaluate" with params ' +
        '{"expression":"1+1","returnByValue":true} \u2014 the raw response nests ' +
        'the value at result.result.value.',
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
            `Timeout in milliseconds applied to each phase independently: ` +
              `discovery, socket open, identity probe, and the CDP call ` +
              `(default ${DEFAULT_TIMEOUT_MS}, floored to ${MIN_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`,
          ),
        metroPort: z
          .number()
          .optional()
          .describe('Override the Metro inspector proxy port for this call.'),
        appId: z
          .string()
          .optional()
          .describe('Override the expected app bundle identifier.'),
      },
    },
    async ({ method, params, timeoutMs, metroPort, appId }) => {
      try {
        const session = getHermesSession();
        const resolved = session.resolve({
          metroPort,
          appId,
          platform: backend.platform,
        });
        const clampedTimeoutMs = Math.min(
          Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
          MAX_TIMEOUT_MS,
        );

        const result = await runHermesCdp({
          method,
          params,
          timeoutMs: clampedTimeoutMs,
          metroPort: resolved.metroPort,
          appId: resolved.appId,
          pinnedDeviceId: resolved.pinnedDeviceId,
          onPin: (id) => {
            const currentPin = session.getPinnedHermesDeviceId();
            if (currentPin === undefined) {
              session.setPinnedHermesDeviceId(id);
            }
          },
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
