// The wallet a paying `mn grant` command pays with: the payer's wallet in this
// process, made into the account package's fee wallet.

import type { FeeWallet } from '@kuiralabs/midnight-account-chain/owner';
import { NATIVE_TOKEN_TYPE } from '../constants.ts';
import type { Payer, PayingTarget } from '../payer.ts';
import type { Spinner } from '../../ui/spinner.ts';
import type { CallSdkWarnings } from '../sdk-warnings.ts';

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
  const connection = await payer.connect(target, wallet, progress, sdkWarnings, signal);
  try {
    const feeWallet = await feeWalletOver({
      getShieldedAddresses: async () => (await connection.call('getShieldedAddresses', {})) as { shieldedCoinPublicKey: string; shieldedEncryptionPublicKey: string },
      balanceUnsealedTransaction: async (tx) => (await connection.call('balanceUnsealedTransaction', { tx })) as { tx: string },
      submitTransaction: (tx) => connection.call('submitTransaction', { tx }),
    });
    const shieldedNight = async (): Promise<bigint> => BigInt(((await connection.call('getShieldedBalances', {})) as Record<string, bigint | undefined>)[NATIVE_TOKEN_TYPE] ?? 0n);
    progress.stop('Wallet ready');
    return { feeWallet, shieldedNight, stop: connection.stop };
  } catch (err) {
    await connection.stop();
    throw err;
  }
}
