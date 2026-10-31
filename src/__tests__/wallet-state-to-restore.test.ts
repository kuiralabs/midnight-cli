// What a wallet with no saved state restores from: a new wallet's state on the
// Dust checkpoint the direct reader holds, so the SDK doesn't replay the
// chain's whole Dust history. `mn contract`'s served wallet once skipped this
// and timed out on stagenet, 226k of 395k Dust events in. A temporary cache
// folder; the facade is built offline (its node relay is never reached).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import { WalletDataRepository } from '../lib/wallet-data-repository.ts';
import { dustPublicKeyHexFromSeed, saveDustCache } from '../lib/dust-direct-cache.ts';
import type { NetworkConfig } from '../lib/network.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';

const NETWORK: NetworkConfig = {
  indexer: 'http://127.0.0.1:1/indexer', indexerWS: 'ws://127.0.0.1:1/indexer/ws',
  node: 'ws://127.0.0.1:1', proofServer: 'http://127.0.0.1:1', networkId: 'Undeployed',
};
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
