// Tests for the serve command's approval flags (argv only; nothing is loaded or synced).

import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError, findUnknownFlags } from '@kuiralabs/midnight-cli-core';
import { serveDefinition } from '@kuiralabs/midnight-connect/commands';
import { installedCommands } from '../lib/installed-commands.ts';
import { cliCall } from './helpers/cli-call.ts';

// The handler, as the shell loads it.
const { default: serveCommand } = await serveDefinition.load();

describe('serve --approve-fees', () => {
  it('is a flag serve accepts', () => {
    expect(findUnknownFlags(parseArgs(['serve', '--approve-fees']), installedCommands)).toEqual([]);
  });

  it('refuses to combine with --approve-all, before loading any wallet', async () => {
    const err = await cliCall(serveCommand, parseArgs(['serve', '--approve-all', '--approve-fees', '--wallet', '/nonexistent/wallet.json']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain('--approve-all and --approve-fees conflict');
  });
});

describe('serve --max-fee / --max-pending', () => {
  it.each([
    [['--max-fee', '0.5'], /only apply with --approve-fees/],
    [['--max-pending', '3'], /only apply with --approve-fees/],
    [['--approve-fees', '--max-fee', 'lots'], /--max-fee must be a positive DUST amount/],
    [['--approve-fees', '--max-pending', '0'], /--max-pending must be a whole number/],
  ])('rejects %j with a usage error before any wallet loads', async (flags, message) => {
    const err = await cliCall(serveCommand, parseArgs(['serve', ...flags])).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(message);
  });
});

describe('serve on a port another process holds', () => {
  it('refuses with SERVE_PORT_IN_USE, naming the port and how to find its process, before any wallet loads or syncs', async () => {
    const { createServer } = await import('node:net');
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as { port: number }).port;
    try {
      const err = await cliCall(serveCommand, parseArgs(['serve', '--port', String(port), '--wallet', '/nonexistent/wallet.json'])).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'SERVE_PORT_IN_USE', message: expect.stringContaining(`Port ${port} is already in use`) });
      expect((err as Error).message).toContain(`${port}`);
      expect((err as Error).message).toMatch(/--port/);
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
    }
  });
});
