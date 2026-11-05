// Which shielded coin a spend takes next. The SDK's balancer asks for one coin
// at a time, with the amount still needed, and by default takes the smallest
// coin it holds unspent. An open swap offer's coins are unspent on chain, so a
// wallet opened later sees them as free: spending one cancels the offer. mn's
// picker skips them (except in the cancel of those offers) and takes a coin
// equal to the amount needed when there is one, so an offer made after a split
// spends exactly the coin the split made.

import { OfferCoinsInUseError, type OpenOffer } from './open-offers.ts';

/** A coin as the picker reads it: its token and its value. */
export interface PickableCoin {
  readonly type: string;
  readonly value: bigint;
}

/** What a spend may use: every coin but the open offers' (`avoid`, the offer holding each by nullifier), or only the coins of the offers it cancels (`only`). */
export type CoinRule =
  | { readonly kind: 'avoid'; readonly held: ReadonlyMap<string, string> }
  | { readonly kind: 'only'; readonly allowed: ReadonlySet<string> };

/**
 * The coin of `tokenType` a spend takes next, of `coins`, under `rule`: one
 * whose value is `amountNeeded` if there is one, otherwise the smallest.
 * Undefined when the wallet holds none it may use; throws OfferCoinsInUseError
 * when the only ones left are held by open offers.
 */
export function pickCoin<C extends PickableCoin>(coins: readonly C[], tokenType: string, amountNeeded: bigint, nullifierOf: (coin: C) => string, rule: CoinRule): C | undefined {
  const ofToken = coins.filter((coin) => coin.type === tokenType);
  const usable = ofToken.filter((coin) => {
    const nullifier = nullifierOf(coin).toLowerCase();
    return rule.kind === 'avoid' ? !rule.held.has(nullifier) : rule.allowed.has(nullifier);
  });
  if (usable.length > 0) {
    return usable.find((coin) => coin.value === amountNeeded) ?? usable.reduce((smallest, coin) => (coin.value < smallest.value ? coin : smallest));
  }
  if (rule.kind === 'avoid' && ofToken.length > 0) {
    const holding = [...new Set(ofToken.map((coin) => rule.held.get(nullifierOf(coin).toLowerCase())!))];
    throw new OfferCoinsInUseError(holding);
  }
  return undefined;
}

/** A wallet's coin picking: the picker its SDK balancer calls, and the cancel that may spend its offers' coins. */
export interface CoinPicking<C extends PickableCoin> {
  /** The coin a spend takes next, as pickCoin picks it under the wallet's open offers now. */
  pick(coins: readonly C[], tokenType: string, amountNeeded: bigint): C | undefined;
  /** Runs `work` with only the coins of `offers` spendable: their cancel. */
  cancelling<T>(offers: readonly OpenOffer[], work: () => Promise<T>): Promise<T>;
}

/**
 * The coin picking of a wallet whose open offers `openOffers` reads (mn's
 * record, read at each pick, so an offer made since counts) and whose coins'
 * nullifiers `nullifierOf` gives.
 */
export function createCoinPicking<C extends PickableCoin>(openOffers: () => readonly OpenOffer[], nullifierOf: (coin: C) => string): CoinPicking<C> {
  let cancel: ReadonlySet<string> | undefined;
  const ruleNow = (): CoinRule => {
    if (cancel !== undefined) return { kind: 'only', allowed: cancel };
    const held = new Map<string, string>();
    for (const offer of openOffers()) for (const nullifier of offer.nullifiers) held.set(nullifier.toLowerCase(), offer.id);
    return { kind: 'avoid', held };
  };
  return {
    pick: (coins, tokenType, amountNeeded) => pickCoin(coins, tokenType, amountNeeded, nullifierOf, ruleNow()),
    async cancelling(offers, work) {
      if (cancel !== undefined) throw new Error('A cancel of open offers is already being built');
      cancel = new Set(offers.flatMap((offer) => offer.nullifiers.map((n) => n.toLowerCase())));
      try {
        return await work();
      } finally {
        cancel = undefined;
      }
    },
  };
}
