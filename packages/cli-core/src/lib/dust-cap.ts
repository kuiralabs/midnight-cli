// The Dust cap the DApp connector API's getDustBalance reports: the most Dust
// the wallet's current NIGHT can generate. Each Dust coin backed by unspent
// NIGHT grows to its own cap (its NIGHT's value times the night-to-Dust
// ratio); a coin whose NIGHT was spent only decays, so it adds nothing.

/** A Dust coin's generation, as the wallet SDK reports it. */
export interface DustCoinGeneration {
  /** The most Dust this coin's NIGHT generates. */
  readonly maxCap: bigint;
  /** When its backing NIGHT was spent; undefined while unspent. */
  readonly dtime: Date | undefined;
}

/** The cap of a wallet whose Dust coins are `coins`: the sum of the caps of those whose NIGHT is unspent. */
export function dustGenerationCap(coins: readonly DustCoinGeneration[]): bigint {
  let cap = 0n;
  for (const coin of coins) if (coin.dtime === undefined) cap += coin.maxCap;
  return cap;
}
