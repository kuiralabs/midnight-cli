// The wallet a paying `mn grant` command pays with: the payer's wallet in this
// process, made into the account package's fee wallet.

import type { FeeWallet } from '@kuiralabs/midnight-account-chain/owner';
import { NATIVE_TOKEN_TYPE, type Payer, type PayingTarget, type CallSdkWarnings } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

/** A fee wallet in this process, and how to stop it. */
export interface PayingWallet {
  feeWallet: FeeWallet;
  /** The shielded NIGHT the synced wallet holds, in the smallest unit. */
  shieldedNight: () => Promise<bigint>;
  stop: () => Promise<void>;
}

/** The payer's wallet for `target`, as the account package's fee wallet, keeping the SDK's warnings to the paying call's `sdkWarnings`. Stopping it stops the wallet. */
export async function openPayingWallet(payer: Payer, target: PayingTarget, wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined): Promise<PayingWallet> {
  const { feeWalletOver } = await import('@kuiralabs/midnight-account-chain/connector');
  const session = await payer.connect(target, wallet, progress, sdkWarnings, signal);
  try {
    const feeWallet = await feeWalletOver({
      getShieldedAddresses: () => session.addresses(),
      balanceUnsealedTransaction: async (tx) => ({ tx: await session.balanceTransaction(tx) }),
      submitTransaction: (tx) => session.submit(tx),
    });
    const shieldedNight = async (): Promise<bigint> => (await session.balances()).shielded[NATIVE_TOKEN_TYPE] ?? 0n;
    progress.stop('Wallet ready');
    return { feeWallet, shieldedNight, stop: () => session.close() };
  } catch (err) {
    await session.close();
    throw err;
  }
}
