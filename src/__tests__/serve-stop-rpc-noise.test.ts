// The serve mn's own commands start in this process (a contract deploy or
// call, a swap, a grant) listens for the SDK's warnings until its wallet has
// stopped. Stopping the wallet closes the SDK's node client, and polkadot-js
// can log a request that failed as it closed: on preview a contract call's
// --json stderr held `RPC-CORE: chain(): Text:: WebSocket is not connected`
// and `Failed WS Request: system_chain`, because the serve stopped listening
// before it stopped the wallet. The guard is the one mn's shell installs; the
// engine is the rc engine but for its wallet's openConnector, which stands in
// at the engine boundary for a synced wallet whose stop logs that line.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHost, type DAppConnector, type Engine } from '@kuiralabs/midnight-cli-core';
import { installSdkProcessGuard, type SdkProcessGuard } from '@kuiralabs/midnight-cli-core/process';
import { reuseServeOrStartAnother } from '@kuiralabs/midnight-connect';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { saveWalletConfig } from '../../test-support/plain-wallet.ts';
import { closedPort } from '../../test-support/closed-port.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
/** polkadot-js's own logger, as the SDK's node client logs through it. */
const { logger } = await import(join(ROOT, 'node_modules/@polkadot/util/logger.js')) as { logger: (origin: string) => { error: (...values: unknown[]) => void } };

const SEED = Buffer.alloc(32, 2);
const ENDPOINTS = { node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws', proofServer: 'http://localhost:26300' };

/** A connector that is asked nothing here: the test is about what the wallet's stop writes. */
const idleConnector: DAppConnector = {
  handlers: {},
  revertPendingTxs: async () => {},
  handOffPendingTx: () => false,
  takeOffer: async () => { throw new Error('not asked'); },
  cancelOffers: async () => { throw new Error('not asked'); },
  holdsFreeCoin: () => false,
  hasPendingTxs: () => false,
  dispose: () => {},
};

describe("a serve mn starts for its own command, stopped", () => {
  let root: string;
  let guard: SdkProcessGuard;
  let stderr: unknown[][];
  let consoleError: typeof console.error;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mn-serve-stop-'));
    saveWalletConfig({ seed: SEED.toString('hex'), addresses: rcKeys.unshieldedAddresses(SEED), createdAt: new Date(0).toISOString() }, join(root, 'wallets', 'two.json'));
    // What reaches the terminal: console.error as the guard finds it.
    stderr = [];
    consoleError = console.error;
    console.error = (...args: unknown[]) => { stderr.push(args); };
    guard = installSdkProcessGuard({ console: true, outsideCalls: 'exit' });
  });

  afterEach(() => {
    guard.uninstall();
    console.error = consoleError;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps polkadot-js's RPC-CORE line, logged as its wallet stops, off stderr", async () => {
    let stopped = false;
    const host = createHost({
      paths: { stateRoot: root, home: root },
      sdkWarnings: guard.calls,
      engineLoader: async (set, loading): Promise<Engine> => {
        const engine = await loadInstalledEngine(set, loading);
        return {
          ...engine,
          wallet: {
            ...engine.wallet,
            openConnector: async () => ({
              connector: idleConnector,
              stop: async () => {
                // As the SDK's node client does when its socket closes under a readiness probe.
                logger('rpc-core').error('chain(): Text:: WebSocket is not connected\nFailed WS Request: {"method":"system_chain","params":[]}');
                stopped = true;
              },
            }),
          },
        };
      },
    });

    await guard.calls.run(async (sdkWarnings) => {
      const serve = await reuseServeOrStartAnother({ root, host, port: await closedPort(), network: 'undeployed', endpoints: ENDPOINTS, wallet: 'two', sdkWarnings });
      await serve.stop();
    });

    expect(stopped).toBe(true);
    expect(stderr.filter((args) => args.some((arg) => String(arg).includes('RPC-CORE')))).toStrictEqual([]);
  });
});
