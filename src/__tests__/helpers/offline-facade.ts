// A real WalletFacade built offline, for running the SDK's own signing on real
// ledger-v9 transactions. Its wallets are never started, so nothing syncs.
//
// Only external I/O is replaced: the submission service (normally a node
// connection) refuses to submit. Endpoints point at a closed loopback port.
// (The beta SDK has no chain-version probe: each wallet has one ledger-v9
// variant.)

import * as ledger from '@midnightntwrk/ledger-v9';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { DustWallet } from '../../lib/dust-wallet.ts';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { PublicKey, UnshieldedWallet, createKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DUST_COST_OVERHEAD, DUST_FEE_BLOCKS_MARGIN } from '../../lib/constants.ts';
import { NETWORK } from './ledger-tx.ts';

/** The secret behind ledger-tx's WALLET_SK, as mn's schnorr keystore takes it. */
export const keystore = createKeystore({ kind: 'schnorr', secret: new Uint8Array(32).fill(1) }, NETWORK);

/** Nothing listens on port 9: a request that does go out fails instead of reaching a network. */
const CLOSED_HTTP = 'http://127.0.0.1:9';
const CLOSED_WS = 'ws://127.0.0.1:9';

export function initOfflineFacade(): Promise<WalletFacade> {
  return WalletFacade.init({
    configuration: {
      networkId: NETWORK,
      indexerClientConnection: { indexerHttpUrl: CLOSED_HTTP, indexerWsUrl: CLOSED_WS },
      costParameters: { additionalFeeOverhead: DUST_COST_OVERHEAD, feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN },
      txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
      provingServerUrl: new URL(CLOSED_HTTP),
      relayURL: new URL(CLOSED_WS),
    },
    submissionService: () => ({
      submitTransaction: () => Promise.reject<never>(new Error('these tests never submit')),
      close: () => Promise.resolve(),
    }),
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(4))),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(
      ledger.DustSecretKey.fromSeed(new Uint8Array(32).fill(5)),
      ledger.LedgerParameters.initialParameters().dust,
    ),
  });
}
