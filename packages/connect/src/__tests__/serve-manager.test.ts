// Reusing a running `mn serve` is only safe on the same chain. Two local
// stacks both call themselves `undeployed`, so the network name alone can't
// tell them apart; the node and indexer the serve reports can.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { serveEndpointMismatch, serveWalletMismatch } from '../lib/serve-manager.ts';
import { createSdkWarningRouter, createHost, contractKeysFromSeed } from '@kuiralabs/midnight-cli-core';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { stateRootIn } from '../../../../test-support/state-root-in.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

// The host the tests' calls run in: nobody to ask, notices dropped, and an engine of its own from the engines the CLI ships.
const host = createHost({ engineLoader: loadInstalledEngine });

const scratch = { node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws' };

describe('serveEndpointMismatch', () => {
  it('allows reuse when the serve reports the requested node and indexer', () => {
    expect(serveEndpointMismatch(
      { substrateNodeUri: scratch.node, indexerWsUri: scratch.indexerWS },
      scratch,
    )).toBeUndefined();
  });

  it('refuses a serve on another local stack with the same network name, naming both sides', () => {
    const reason = serveEndpointMismatch(
      { substrateNodeUri: 'ws://localhost:9944', indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws' },
      scratch,
    );
    expect(reason).toContain('node ws://localhost:9944 (need ws://localhost:29944)');
    expect(reason).toContain('indexer ws://localhost:8088/api/v4/graphql/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('treats a trailing slash as the same endpoint', () => {
    expect(serveEndpointMismatch(
      { substrateNodeUri: `${scratch.node}/`, indexerWsUri: scratch.indexerWS },
      scratch,
    )).toBeUndefined();
  });

  it('refuses when only one endpoint differs', () => {
    expect(serveEndpointMismatch({ substrateNodeUri: scratch.node, indexerWsUri: 'ws://elsewhere/ws' }, scratch))
      .toBe('indexer ws://elsewhere/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('refuses a serve that does not report its endpoints', () => {
    expect(serveEndpointMismatch({}, scratch)).toBeDefined();
  });
});

describe('serveWalletMismatch', () => {
  const wanted = { address: 'mn_addr_undeployed1two', name: 'two' };

  it('allows reuse when the serve pays from the wallet the command was given', () => {
    expect(serveWalletMismatch('mn_addr_undeployed1two', wanted)).toBeUndefined();
  });

  it('refuses a serve that pays from another wallet, naming both', () => {
    expect(serveWalletMismatch('mn_addr_undeployed1bob', wanted))
      .toBe('it serves the wallet at mn_addr_undeployed1bob, and this command pays from two (mn_addr_undeployed1two)');
  });

  // Regression: a serve that would not say whose wallet it is was reused, so
  // a command could be paid for from another wallet with no word of it.
  it('refuses a serve that does not say whose it is: it can\'t be shown to pay from the wallet', () => {
    expect(serveWalletMismatch(null, wanted)).toBe('it does not say which wallet it pays from (it asks its operator before answering), and this command pays from two (mn_addr_undeployed1two)');
  });
});

describe('startServeOrReuse against a running serve', () => {
  // A fake `mn serve`: a real JSON-RPC WebSocket server answering the two
  // probes the reuse check makes. Endpoints are passed explicitly, so neither
  // docker nor saved config affects what is requested.
  // A state root of the test's own, with no config, for the calls that need no wallet.
  let emptyRoot: string;
  beforeEach(() => { emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-serve-root-')); });
  afterEach(() => fs.rmSync(emptyRoot, { recursive: true, force: true }));

  async function fakeServe(configuration: Record<string, string>, unshieldedAddress?: string) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      const result = req.method === 'connect' ? { networkId: 'undeployed' }
        : req.method === 'getConnectionStatus' ? { status: 'connected', networkId: 'undeployed' }
        : req.method === 'getConfiguration' ? configuration
        : req.method === 'getUnshieldedAddress' && unshieldedAddress !== undefined ? { unshieldedAddress } : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    }));
    const port = (wss.address() as import('node:net').AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => wss.close(() => r())) };
  }

  const requested = {
    node: 'ws://localhost:29944',
    indexerWS: 'ws://localhost:28088/api/v4/graphql/ws',
    proofServer: 'http://localhost:26300',
  };

  // Regression: the advice was `pkill -f 'mn serve'`, which stops every serve on the machine.
  it('refuses a port held by something else, saying how to stop only the process on that port', async () => {
    const { startServeOrReuse, ServeNotReusableError } = await import('../lib/serve-on-port.ts');
    const { createServer } = await import('node:net');
    const other = createServer((socket) => { socket.on('error', () => {}); socket.write('not a websocket', () => socket.destroy()); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const port = (other.address() as import('node:net').AddressInfo).port;
    try {
      const refusal = await startServeOrReuse({ root: emptyRoot, host, port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested }).catch((e: Error) => e);
      expect(refusal).toBeInstanceOf(ServeNotReusableError);
      expect((refusal as Error & { code: string }).code).toBe('SERVE_PORT_IN_USE');
      expect((refusal as Error).message).toContain(`Port ${port} is in use by a process that does not look like mn serve.`);
      expect((refusal as Error).message).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      expect((refusal as Error).message).not.toContain('pkill');
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  // Regression: a deploy checked the port before its sync and bound it after,
  // so two at once both synced and the second failed with EADDRINUSE.
  it('for mn\'s payer, starts its own serve on a free port instead, never touching the taken port', async () => {
    const { reuseServeOrStartAnother } = await import('../lib/serve-manager.ts');
    const { createServer } = await import('node:net');
    const other = createServer((socket) => { socket.on('error', () => {}); socket.write('not a websocket', () => socket.destroy()); });
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
    const port = (other.address() as import('node:net').AddressInfo).port;
    const messages: string[] = [];
    try {
      // No wallet under this root: the new serve gets as far as opening it, on a port of its own.
      await expect(reuseServeOrStartAnother({ root: emptyRoot, host, port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested, onMessage: (m: string) => messages.push(m) }))
        .rejects.toThrow(/wallet/i);
      expect(messages).toContain(`Not reusing port ${port}: Port ${port} is in use by a process that does not look like mn serve.`);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it('binds its port before it opens the wallet: a taken port fails at once, not after a sync', async () => {
    const { startServe } = await import('../lib/serve-manager.ts');
    const serve = await fakeServe({});
    try {
      // No wallet under this root: reaching the wallet would fail differently.
      const failed = await startServe({ root: emptyRoot, host, port: serve.port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested }).catch((e: Error) => e);
      expect((failed as Error).message).toContain(`Could not start mn serve on port ${serve.port}`);
      expect(((failed as Error).cause as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
    } finally {
      await serve.close();
    }
  });

  it('refuses a serve for the same network name on a different chain', async () => {
    const { startServeOrReuse } = await import('../lib/serve-on-port.ts');
    const serve = await fakeServe({ substrateNodeUri: 'ws://localhost:9944', indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws' });
    try {
      await expect(startServeOrReuse({ root: emptyRoot, host, port: serve.port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested }))
        .rejects.toThrow(/on a different undeployed chain: node ws:\/\/localhost:9944 \(need ws:\/\/localhost:29944\)/);
    } finally {
      await serve.close();
    }
  });

  describe('for a wallet', () => {
    const TWO = Buffer.alloc(32, 2);
    const BOB = Buffer.alloc(32, 7);
    const sameChain = { substrateNodeUri: requested.node, indexerWsUri: requested.indexerWS };
    let home: string;
    let origHome: string | undefined;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-serve-reuse-'));
      origHome = process.env.HOME;
      process.env.HOME = home;
      fs.mkdirSync(path.join(home, '.midnight', 'wallets'), { recursive: true });
      for (const [name, seed] of [['two', TWO], ['bob', BOB]] as const) {
        saveWalletConfig(
          { seed: seed.toString('hex'), addresses: rcKeys.unshieldedAddresses(seed), createdAt: new Date(0).toISOString() },
          path.join(home, '.midnight', 'wallets', `${name}.json`),
        );
      }
    });

    afterEach(() => {
      process.env.HOME = origHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('reuses a serve that pays from that wallet, with that wallet\'s contract keys, and does not stop what it did not start', async () => {
      const { startServeOrReuse } = await import('../lib/serve-on-port.ts');
      const { probeServeNetwork } = await import('../lib/serve-manager.ts');
      const serve = await fakeServe(sameChain, rcKeys.unshieldedAddresses(TWO).undeployed);
      try {
        const messages: string[] = [];
        const handle = await startServeOrReuse({ root: stateRootIn(home), host, port: serve.port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested, wallet: 'two', onMessage: (m: string) => messages.push(m) });
        expect(handle.port).toBe(serve.port);
        expect(handle.contractKeys).toEqual(contractKeysFromSeed(TWO));
        expect(messages).toContain(`Reusing existing mn serve on port ${serve.port}`);
        await handle.stop(); // a no-op for a reused serve: the fake must still answer
        expect(await probeServeNetwork(serve.port)).toBe('undeployed');
      } finally {
        await serve.close();
      }
    });

    it('refuses a serve on the same chain that does not say which wallet it pays from', async () => {
      const { startServeOrReuse } = await import('../lib/serve-on-port.ts');
      const serve = await fakeServe(sameChain);
      try {
        await expect(startServeOrReuse({ root: stateRootIn(home), host, port: serve.port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested, wallet: 'two' }))
          .rejects.toThrow('it does not say which wallet it pays from');
      } finally {
        await serve.close();
      }
    });

    // Found reading the code: `mn grant --wallet two` beside a running serve
    // for bob had bob pay, with no word of it.
    it('refuses a serve that pays from another wallet, on the same chain', async () => {
      const { startServeOrReuse } = await import('../lib/serve-on-port.ts');
      const bob = rcKeys.unshieldedAddresses(BOB).undeployed;
      const serve = await fakeServe(sameChain, bob);
      try {
        await expect(startServeOrReuse({ root: stateRootIn(home), host, port: serve.port, network: 'undeployed', sdkWarnings: createSdkWarningRouter().openCall().warnings, endpoints: requested, wallet: 'two' }))
          .rejects.toThrow(`can't pay for this command: it serves the wallet at ${bob}, and this command pays from two (${rcKeys.unshieldedAddresses(TWO).undeployed})`);
      } finally {
        await serve.close();
      }
    });
  });
});
