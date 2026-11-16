import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, it, expect, vi } from 'vitest';

import { registerSnapshotTool } from './snapshot.js';
import type { DeviceBackend, SnapshotResult } from '../backends/types.js';

type ToolHandler = () => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

const snapshotResult: SnapshotResult = {
  platform: 'ios',
  hierarchy: [
    {
      type: 'Button',
      label: 'Unlock',
      identifier: 'log-in-button',
      frame: { x: 24, y: 396, width: 354, height: 48 },
      enabled: true,
    },
  ],
  raw: '[]',
  timestamp: Date.UTC(2026, 10, 16),
};

async function runTool(
  snapshot: DeviceBackend['snapshot'],
): ReturnType<ToolHandler> {
  const server = { registerTool: vi.fn() } as unknown as McpServer;
  registerSnapshotTool(server, { snapshot } as unknown as DeviceBackend);
  const { calls } = (server.registerTool as ReturnType<typeof vi.fn>).mock;
  expect(calls[0][0]).toBe('device_snapshot');
  return (calls[0][2] as ToolHandler)();
}

describe('registerSnapshotTool', () => {
  it('prints the platform, timestamp and elements, without a warnings line', async () => {
    const result = await runTool(vi.fn().mockResolvedValue(snapshotResult));

    expect(result.content[0].text).toBe(
      [
        'Platform: ios',
        'Timestamp: 2026-11-16T00:00:00.000Z',
        'Elements:',
        '[Button] label="Unlock" id="log-in-button" (24,396 354x48)',
      ].join('\n'),
    );
  });

  it.each([[[]], [undefined]])(
    'prints no warnings line for warnings %j',
    async (warnings) => {
      const result = await runTool(
        vi.fn().mockResolvedValue({ ...snapshotResult, warnings }),
      );

      expect(result.content[0].text).not.toContain('Warnings:');
    },
  );

  it('prints the warnings before the elements', async () => {
    const result = await runTool(
      vi.fn().mockResolvedValue({
        ...snapshotResult,
        warnings: [
          'ax-tree-truncated(backend=axbridge-exclusive,depth=51,nodes=166)',
          'other-warning',
        ],
      }),
    );

    expect(result.content[0].text.split('\n').slice(0, 4)).toStrictEqual([
      'Platform: ios',
      'Timestamp: 2026-11-16T00:00:00.000Z',
      'Warnings: ax-tree-truncated(backend=axbridge-exclusive,depth=51,nodes=166); other-warning',
      'Elements:',
    ]);
  });

  it('returns an error result when the snapshot fails', async () => {
    const result = await runTool(
      vi.fn().mockRejectedValue(new Error('describe-all failed')),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('describe-all failed');
  });
});
