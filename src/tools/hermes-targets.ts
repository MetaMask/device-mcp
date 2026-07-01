import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { errorResult } from './shared.js';
import type { DeviceBackend } from '../backends/types.js';
import {
  fetchDiscoveryTargets,
  hasAmbiguousTarget,
  LEGACY_SYNTHETIC_TITLE,
  selectHermesTarget,
} from '../hermes/hermes-cdp.js';
import type { HermesTarget } from '../hermes/hermes-cdp.js';
import { getHermesSession } from '../hermes/session.js';

const DISCOVERY_TIMEOUT_MS = 10_000;

function formatTarget(target: HermesTarget): string {
  const { reactNative } = target;
  return [
    `  id: ${target.id ?? '<unknown>'}`,
    `  title: ${target.title ?? '<unknown>'}`,
    `  appId: ${target.appId ?? '<unknown>'}`,
    `  logicalDeviceId: ${reactNative?.logicalDeviceId ?? '<missing>'}`,
    `  nativePageReloads: ${
      reactNative?.capabilities?.nativePageReloads ?? '<unset>'
    }`,
    `  wsUrl: ${target.webSocketDebuggerUrl ?? '<missing>'}`,
  ].join('\n');
}

function describeMetroDown(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
    return 'Metro not running or no debuggable app registered.';
  }
  return undefined;
}

/**
 * Registers the `hermes_targets` MCP tool, which lists and diagnoses the
 * debuggable Hermes targets that Metro's inspector proxy currently exposes
 * (iOS and Android).
 *
 * The handler is THIN: it resolves the Metro port/appId from
 * {@link getHermesSession}, delegates discovery to {@link fetchDiscoveryTargets}
 * and selection/ambiguity reporting to {@link selectHermesTarget} /
 * {@link hasAmbiguousTarget}, and formats a readable report. With `all` set,
 * it bypasses the appId filter so agents can discover the real appId / confirm
 * Metro is up. No discovery or selection LOGIC lives in this file.
 *
 * @param server - The MCP server to register the tool on.
 * @param backend - The lazy device backend, used at call time only to read the
 * live platform so the session can resolve the correct default app bundle ID.
 */
export function registerHermesTargetsTool(
  server: McpServer,
  backend: DeviceBackend,
): void {
  server.registerTool(
    'hermes_targets',
    {
      title: 'Hermes Targets',
      description:
        'List and diagnose the debuggable React Native Hermes targets that ' +
        'Metro\u2019s inspector proxy currently exposes (iOS and Android). ' +
        'Reports each candidate (id / title / appId / logicalDeviceId / ' +
        'nativePageReloads / wsUrl) plus which target would be chosen or why ' +
        'it is ambiguous. Use it to confirm Metro is running and your app is ' +
        'registered. Requires a DEBUG build with Metro running.',
      inputSchema: {
        metroPort: z
          .number()
          .optional()
          .describe('Override the Metro inspector proxy port for this call.'),
        appId: z
          .string()
          .optional()
          .describe('Override the expected app bundle identifier.'),
        all: z
          .boolean()
          .optional()
          .describe(
            'Bypass the appId filter and list ALL candidates (diagnostics).',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ metroPort, appId, all }) => {
      try {
        const resolved = getHermesSession().resolve({
          metroPort,
          appId,
          platform: backend.platform,
        });
        const targets = await fetchDiscoveryTargets(
          resolved.metroPort,
          DISCOVERY_TIMEOUT_MS,
        );

        if (targets.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Metro not running or no debuggable app registered.',
              },
            ],
          };
        }

        const candidates = all
          ? targets
          : targets
              .filter((target) => Boolean(target.webSocketDebuggerUrl))
              .filter((target) => target.title !== LEGACY_SYNTHETIC_TITLE)
              .filter((target) => target.appId === resolved.appId);

        const lines: string[] = [
          `Metro port: ${resolved.metroPort}`,
          `Expected appId: ${resolved.appId}${all ? ' (filter bypassed by all=true)' : ''}`,
          `Targets discovered: ${targets.length}`,
          `Candidates listed: ${candidates.length}`,
          '',
        ];

        candidates.forEach((target, index) => {
          lines.push(`Candidate ${index + 1}:`, formatTarget(target), '');
        });

        const selection = selectHermesTarget(
          targets,
          resolved.appId,
          resolved.pinnedDeviceId,
        );
        if (selection.ok) {
          lines.push(
            `Chosen target: ${selection.target.id ?? '<unknown>'} (device=${
              selection.target.reactNative?.logicalDeviceId ?? '<missing>'
            })`,
          );
        } else if (
          selection.code === 'HERMES_MULTIPLE_DEVICES' &&
          hasAmbiguousTarget(candidates)
        ) {
          lines.push(`Ambiguous: ${selection.message}`);
        } else {
          lines.push(
            `No target chosen: [${selection.code}] ${selection.message}`,
          );
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        const metroDown = describeMetroDown(error);
        if (metroDown) {
          return {
            content: [{ type: 'text' as const, text: metroDown }],
          };
        }
        return errorResult(error);
      }
    },
  );
}
