// What an engine's transfers take: amounts of NIGHT as bigint in its smallest
// unit, refused when not above 0 before anything reaches the chain, and
// carried whole past what a JS number holds (2^53 micro-NIGHT) to where the
// wallet first asks the chain, the repository's protocol-version read, which a
// test stands in for with a ledger-8 chain so the call stops there. A
// submitted transfer needs a chain: the scratch chain's live runs cover it.
//
// This file loads no engine: each test file that runs it passes one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine, EngineHost, TransferParams } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';
import { withCallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui/spinner';

/** What the suite takes from an engine: how to make it with its repository's protocol-version read. */
export interface TransferEngine {
  set: string;
  createEngine(host: EngineHost, options: { repository: { fetchProtocolVersion: (indexerHttpUrl: string) => Promise<bigint | null> } }): Engine;
}

const NETWORK: NetworkConfig = { indexer: 'http://test/indexer', indexerWS: 'ws://test/indexer/ws', node: 'ws://test/node', proofServer: 'http://test/proof', networkId: 'Undeployed' };
const SEED = Buffer.alloc(32, 9);
// 9007199254.740993 NIGHT: one micro-NIGHT past what a JS number carries exactly.
const LARGE = 2n ** 53n + 1n;
// The protocol version of a ledger-8 chain, below the ledger-9 fork.
const LEDGER_8 = 1_000_000n;

export function engineTransferSuite(engine: TransferEngine): void {
  describe(`the ${engine.set} engine's transfer amounts`, () => {
    let root: string;
    beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mn-engine-transfer-')); });
    afterAll(() => { rmSync(root, { recursive: true, force: true }); });

    /** An engine whose chain is on ledger 8, and the indexers it asked for the chain's version. */
    function onLedger8() {
      const asked: string[] = [];
      const host = createHost({ paths: { stateRoot: root, home: root } });
      const made = engine.createEngine(host, { repository: { fetchProtocolVersion: async (url) => { asked.push(url); return LEDGER_8; } } });
      return { host, wallet: made.wallet, recipient: made.keys.unshieldedAddress(Buffer.alloc(32, 3), 'undeployed'), shieldedRecipient: made.keys.shieldedAddress(Buffer.alloc(32, 3), 'undeployed'), asked };
    }

    /** What `transfer` and `airdrop` take, but the amount. */
    const paramsOf = (host: EngineHost, recipientAddress: string) => (amount: bigint, run: (params: TransferParams) => Promise<unknown>) =>
      withCallSdkWarnings(createHost().sdkWarnings, undefined, (sdkWarnings) => run({ seedBuffer: SEED, networkConfig: NETWORK, recipientAddress, amount, sdkWarnings, root, notice: host.notice }));

    it.each([0n, -1n])('refuses %s NIGHT to transfer or airdrop before it asks the chain', async (amount) => {
      const { host, wallet, recipient, asked } = onLedger8();
      const call = paramsOf(host, recipient);
      await expect(call(amount, (params) => wallet.transfer(params))).rejects.toThrow('Amount must be greater than 0');
      await expect(call(amount, ({ seedBuffer: _genesisPays, ...params }) => wallet.airdrop(params))).rejects.toThrow('Amount must be greater than 0');
      expect(asked).toEqual([]);
    });

    it('carries an amount past what a number holds to the chain: transfer, airdrop and a shielded transfer', async () => {
      const { host, wallet, recipient, shieldedRecipient, asked } = onLedger8();
      const call = paramsOf(host, recipient);
      await expect(call(LARGE, (params) => wallet.transfer(params))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
      await expect(call(LARGE, ({ seedBuffer: _genesisPays, ...params }) => wallet.airdrop(params))).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
      await expect(wallet.shieldedTransfer({
        seed: SEED,
        root,
        notice: host.notice,
        network: 'undeployed',
        networkConfig: NETWORK,
        recipient: shieldedRecipient,
        amount: LARGE,
        progress: silentSpinner(),
        insufficient: (available) => `${available} NIGHT available`,
        waitForDustToCover: false,
      })).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
      expect(asked).toEqual([NETWORK.indexer, NETWORK.indexer, NETWORK.indexer]);
    });

    it('refuses a recipient of another network before it asks the chain', async () => {
      const { host, wallet, asked } = onLedger8();
      const preprod = engine.createEngine(host, { repository: { fetchProtocolVersion: async () => LEDGER_8 } }).keys.unshieldedAddress(Buffer.alloc(32, 3), 'preprod');
      await expect(paramsOf(host, preprod)(1_000_000n, (params) => wallet.transfer(params))).rejects.toThrow('Expected a bech32m address for network "Undeployed"');
      expect(asked).toEqual([]);
    });
  });
}
