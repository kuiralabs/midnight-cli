// The wallet a paying `mn grant` command pays with: the payer's wallet in this
// process, made into the account package's fee wallet.

import type { FeeWallet } from '@kuiralabs/midnight-account-chain/owner';
import type { AccountChain } from './account-chain.ts';
import { type ConnectOptions, type Payer, type PayingTarget, type CallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

/** A fee wallet in this process, and how to stop it. */
export interface PayingWallet {
  feeWallet: FeeWallet;
  /** What the synced wallet holds shielded of the token whose raw type is `tokenType`, in its smallest unit. */
  shieldedBalance: (tokenType: string) => Promise<bigint>;
  stop: () => Promise<void>;
}

/**
 * The payer's wallet for `target`, as the fee wallet of the account package's `connector` (the network engine's), keeping the SDK's warnings to the paying call's `sdkWarnings`. Stopping it stops the wallet.
 * `options` asks for the shielded side to be synced, which a deposit spends from (a network without shielded sync by default skips it otherwise).
 */
export async function openPayingWallet(payer: Payer, target: PayingTarget, connector: AccountChain['connector'], wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined, options?: ConnectOptions): Promise<PayingWallet> {
  const { feeWalletOver } = connector;
  const session = await payer.connect(target, wallet, progress, sdkWarnings, signal, options);
  try {
    const feeWallet = await feeWalletOver({
      getShieldedAddresses: () => session.addresses(),
      balanceUnsealedTransaction: async (tx) => ({ tx: await session.balanceTransaction(tx) }),
      submitTransaction: (tx) => session.submit(tx),
    });
    const shieldedBalance = async (tokenType: string): Promise<bigint> => (await session.balances()).shielded[tokenType] ?? 0n;
    progress.stop('Wallet ready');
    return { feeWallet, shieldedBalance, stop: () => session.close() };
  } catch (err) {
    await session.close();
    throw err;
  }
}
