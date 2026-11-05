// The shielded wallet the facade wraps, built as the SDK's `ShieldedWallet`
// builds it (a variant either side of the ledger-9 boundary, the chain asked
// which side it is on) with mn's coin picker on the ledger-9 side: a spend
// skips the coins of the wallet's open swap offers, except in their cancel,
// and takes a coin of the exact amount when there is one. The ledger-8 side
// keeps the SDK's picker: every network mn writes to is past the boundary.

import { CustomForkingShieldedWallet, type ShieldedWallet, type ShieldedWalletClass } from '@midnightntwrk/wallet-sdk/shielded';
import { V1Builder } from '@midnightntwrk/wallet-sdk/shielded/v1';
import { Migration, V2Builder } from '@midnightntwrk/wallet-sdk/shielded/v2';
import { makeIndexerChainVersionProbe } from '@midnightntwrk/wallet-sdk/capabilities';
import * as ledger from '@midnightntwrk/ledger-v9';
import { createCoinPicking, type CoinPicking } from '@kuiralabs/midnight-cli-core/engine';
import type { OpenOffer } from '@kuiralabs/midnight-cli-core';

/** A shielded coin as the SDK's balancer hands it to the picker. */
export type ShieldedCoin = ledger.QualifiedShieldedCoinInfo;

/**
 * A coin's nullifier under the wallet's shielded seed. The keys are derived
 * for each one and cleared after: a key held on its own is cleared by the
 * ledger once the keys it came from are collected ("Coin secret key was
 * cleared"), which broke a spend rebuilt after a wait for Dust.
 */
export function shieldedNullifier(shieldedSeed: Uint8Array, coin: ShieldedCoin): string {
  const keys = ledger.ZswapSecretKeys.fromSeed(shieldedSeed);
  try {
    return ledger.coinNullifier({ type: coin.type, nonce: coin.nonce, value: coin.value }, keys.coinSecretKey);
  } finally {
    keys.clear();
  }
}

/** The coin picking of the wallet with this shielded seed, whose open offers `openOffers` reads. */
export function shieldedCoinPicking(shieldedSeed: Uint8Array, openOffers: () => readonly OpenOffer[]): CoinPicking<ShieldedCoin> {
  return createCoinPicking<ShieldedCoin>(openOffers, (coin) => shieldedNullifier(shieldedSeed, coin));
}

/** What the SDK's own `ShieldedWallet` is built from. */
type ShieldedConfiguration = Parameters<typeof ShieldedWallet>[0];

/** The shielded wallet class for `configuration` (the facade's), spending as `picking` picks. */
export function PickingShieldedWallet(configuration: ShieldedConfiguration, picking: CoinPicking<ShieldedCoin>): ShieldedWalletClass {
  const withProbe = {
    ...configuration,
    chainVersionProbe: configuration.chainVersionProbe ?? makeIndexerChainVersionProbe(configuration),
  };
  return CustomForkingShieldedWallet(
    withProbe,
    { builder: new V1Builder().withDefaults(), configuration },
    {
      builder: new V2Builder()
        .withDefaults()
        .withMigration(() => Migration.makeCrossLedgerMigration())
        .withCoinSelection(() => (coins, tokenType, amountNeeded) => picking.pick(coins, tokenType, amountNeeded)),
      configuration,
    },
  );
}
