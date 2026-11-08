// What a paying path reads after the node refused a fee as too low: the
// refused transaction's fee as the wallet prices it now, and the wallet's Dust
// (repriceAfterFeeRefusal sets one against the other).

import type { FeeRefusalCheck } from '@kuiralabs/midnight-cli-core/engine';
import type { FacadeState, WalletFacade } from '@midnightntwrk/wallet-sdk/facade';

/**
 * The refused transaction's fee, priced by the SDK with the ledger parameters
 * of the chain's tip and the wallet's fee settings as they are now (the
 * transaction carries its own Dust spends, so this is the whole fee), and the
 * Dust `state` holds now: the SDK put back what the refused transaction held
 * when its submit failed.
 */
export async function refusedFeeCheck(facade: Pick<WalletFacade, 'calculateTransactionFee'>, refused: Parameters<WalletFacade['calculateTransactionFee']>[0], state: Pick<FacadeState, 'dust'>): Promise<FeeRefusalCheck> {
  const fee = await facade.calculateTransactionFee(refused);
  return { fee, dust: state.dust.balance(new Date()) };
}
