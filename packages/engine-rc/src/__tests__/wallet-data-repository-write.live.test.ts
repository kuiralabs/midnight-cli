// What a write leaves behind: withFacade saves the wallet's synced state after
// its work, and the next write restores from it instead of building the wallet
// from its keys (which on a hosted network replays the chain's Dust history in
// WASM). The work here submits nothing: withFacade treats any borrower that
// isn't read-only as a write. Live (`npm run test:live`): it syncs a wallet on
// undeployed's chain (its saved endpoints or the defaults), in a temporary
// state root.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWalletCache } from '@kuiralabs/midnight-cli-core/engine';
import { type NetworkConfig, parseArgs, resolveNetwork } from '@kuiralabs/midnight-cli-core';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { deriveUnshieldedAddress } from '../derive-address.ts';
import { testHost } from '../../../../test-support/test-host.ts';

let NETWORK: NetworkConfig;

beforeAll(async () => {
  NETWORK = resolveNetwork({ args: parseArgs(['balance', '--network', 'undeployed']), configDir: testHost().paths().stateRoot }, testHost().settings()).config;
  const answered = await fetch(NETWORK.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ block { protocolVersion } }' }), signal: AbortSignal.timeout(5_000) })
    .then(async (r) => ((await r.json()) as { data?: { block?: { protocolVersion?: number } } }).data?.block?.protocolVersion ?? null, () => null);
  if (answered === null) throw new Error(`No indexer answers at ${NETWORK.indexer}: start the local chain (or point undeployed at one with midnight config set) before npm run test:live.`);
});

const SEED = Buffer.from('5a'.repeat(32), 'hex');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mn-write-cache-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('withFacade after a write', () => {
  it('keeps the wallet state it saved, and the next write restores from it', async () => {
    const repo = new WalletDataRepository(testHost());
    const write = () => repo.withFacade(SEED, NETWORK, async (lease) => lease.bundle.restoredFromCache, { root, notice: () => {}, syncMode: 'lite' });

    await write();
    expect(loadWalletCache(deriveUnshieldedAddress(SEED, 'undeployed'), 'undeployed', root), 'the state the write saved').not.toBeNull();

    expect(await write(), 'the next write restores the saved wallet').toBe(true);
  }, 240_000);
});
