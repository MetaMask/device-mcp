import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../backends/index.js', () => ({
  createLazyBackend: () => ({ dispose: mocks.dispose }),
}));
vi.mock('../server.js', () => ({
  createMcpServer: () => ({
    server: {},
    connect: mocks.connect,
    close: mocks.close,
  }),
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

describe('device-mcp CLI shutdown', () => {
  const callbacks = new Map<string, () => void>();

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    callbacks.clear();
    mocks.dispose.mockResolvedValue(undefined);
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
    vi.spyOn(process, 'once').mockImplementation((event, callback) => {
      callbacks.set(event, callback);
      return process;
    });
    vi.spyOn(process.stdin, 'once').mockImplementation((event, callback) => {
      callbacks.set(event, callback);
      return process.stdin;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['SIGINT', 'SIGTERM', 'end'])(
    'disposes the backend and closes stdio on %s',
    async (event) => {
      await import('./device-mcp.js');
      await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
      callbacks.get(event)?.();
      callbacks.get(event)?.();
      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0));
      expect(mocks.dispose).toHaveBeenCalledTimes(1);
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(mocks.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.close.mock.invocationCallOrder[0],
      );
    },
  );

  it('closes the server and reports a disposal failure', async () => {
    mocks.dispose.mockRejectedValue(new Error('stop failed'));
    await import('./device-mcp.js');
    callbacks.get('SIGTERM')?.();
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
});
