// What a wallet with no saved state restores from: a new wallet's state on the
// Dust checkpoint the direct reader holds, so the SDK doesn't replay the
// chain's whole Dust history. `mn contract`'s served wallet once skipped this
// and timed out on stagenet, 226k of 395k Dust events in. A temporary cache
// folder. Live (`npm run test:live`): a new wallet reads the chain's protocol
// version from undeployed's indexer (its saved endpoints or the defaults), and
// a ledger-9 checkpoint only goes into a wallet on ledger 9.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { WalletDataRepository } from '../engine/rc/wallet-data-repository.ts';
import { dustPublicKeyHexFromSeed, saveDustCache } from '../engine/rc/dust-direct-cache.ts';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';

let NETWORK: NetworkConfig;

beforeAll(async () => {
  NETWORK = resolveNetwork({ args: parseArgs(['balance', '--network', 'undeployed']) }).config;
  const answered = await fetch(NETWORK.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ block { protocolVersion } }' }), signal: AbortSignal.timeout(5_000) })
    .then(async (r) => ((await r.json()) as { data?: { block?: { protocolVersion?: number } } }).data?.block?.protocolVersion ?? null, () => null);
  if (answered === null) throw new Error(`No indexer answers at ${NETWORK.indexer}: start the local chain (or point undeployed at one with midnight config set) before npm run test:live.`);
  if (answered < 2_000_000) throw new Error(`undeployed's indexer at ${NETWORK.indexer} is on ledger 8 (protocol ${answered}); these tests need a ledger-9 chain.`);
});
const SEED = Buffer.from('11'.repeat(32), 'hex');

let cacheDir: string;
beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'mn-restore-state-')); });
afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

describe('walletStateToRestore', () => {
  it('with no saved wallet, starts the Dust wallet at the checkpoint the direct reader holds', async () => {
    const checkpoint = ledger.DustLocalState.deserialize(Buffer.from(DUST_STATE_OWNED_HEX, 'hex'));
    saveDustCache('undeployed', dustPublicKeyHexFromSeed(SEED), checkpoint, 395_185, cacheDir);

    const state = await new WalletDataRepository({ cacheDir }).walletStateToRestore(SEED, NETWORK, 'undeployed');

    expect(state, 'a wallet to restore, not one built from its keys').not.toBeNull();
    const dust = JSON.parse(state!.dust) as { offset: string; state: string };
    expect(dust.offset, 'resumes after the checkpoint, not from event 0').toBe('395185');
    expect(dust.state).toBe(Buffer.from(checkpoint.serialize()).toString('hex'));
  }, 30_000);

  it('with no saved wallet and no checkpoint, is null: the wallet is built from its keys', async () => {
    expect(await new WalletDataRepository({ cacheDir }).walletStateToRestore(SEED, NETWORK, 'undeployed')).toBeNull();
  });
});
