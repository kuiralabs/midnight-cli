// Topping up a wallet mn's local flows reuse: a wallet holding less NIGHT than
// the flow funds with generates its Dust that much slower (mn dev's wallets
// and mn test's were funded with 1000 NIGHT before LOCAL_WALLET_FUNDING_NIGHT),
// so on the local network the flow airdrops the difference from genesis.

import { nightToMicro, type NetworkName } from '@kuiralabs/midnight-cli-core';

/** Micro-NIGHT to airdrop so a wallet holding `heldMicro` has `targetNight`: 0 when it already has as much. */
export function topUpShortfall(heldMicro: bigint, targetNight: number): bigint {
  const target = nightToMicro(targetNight);
  return heldMicro < target ? target - heldMicro : 0n;
}

/** What mn test's `balance:<N>` step does with a wallet holding `heldMicro`. */
export type BalanceStepPlan =
  | { kind: 'enough' }
  /** Local network: airdrop `amount` micro-NIGHT from genesis, bringing the wallet to the step's N. */
  | { kind: 'top-up'; amount: bigint }
  /** A hosted network and no NIGHT: the person funds the wallet. */
  | { kind: 'unfunded' };

/**
 * The `balance:<N>` step's plan. On the local network the wallet is brought up
 * to N, as the test file names it (never raised past it); on any other network
 * any NIGHT is enough, as before, and none is the person's to fund.
 */
export function planBalanceStep(network: NetworkName, heldMicro: bigint, targetNight: number): BalanceStepPlan {
  if (network !== 'undeployed') return heldMicro > 0n ? { kind: 'enough' } : { kind: 'unfunded' };
  const amount = topUpShortfall(heldMicro, targetNight);
  return amount > 0n ? { kind: 'top-up', amount } : { kind: 'enough' };
}
