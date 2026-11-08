// The wallet a paying `mn grant` command pays with: the payer's wallet in this
// process, made into the account package's fee wallet.

import type { FeeWallet } from '@kuiralabs/midnight-account-chain/owner';
import type { AccountChain } from './account-chain.ts';
import { type ConnectOptions, type Payer, type PayingTarget, type CallSdkWarnings, DUST_DOUBLE_SPEND_RETRIES, DUST_FEE_MARGIN_STEPS, FEE_TOO_LOW_CODE, isDustDoubleSpent, isFeeRepriced, RERUN_DOUBLE_SPENT_STATUS, RERUN_REPRICED_STATUS, rerunWhenRepriced } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

/** A fee wallet in this process, and how to stop it. */
export interface PayingWallet {
  feeWallet: FeeWallet;
  /** What the synced wallet holds shielded of the token whose raw type is `tokenType`, in its smallest unit. */
  shieldedBalance: (tokenType: string) => Promise<bigint>;
  /**
   * Runs a payment, and again when its submit was refused because the node
   * took its fee as too low and the wallet now prices with a larger margin
   * (FEE_REPRICED), saying so through `onStatus`, at most once per larger
   * margin. The account package carries on from the step it recorded.
   * Past the largest margin the payment fails with the wallet's FEE_TOO_LOW.
   */
  repricing: <T>(pay: () => Promise<T>, onStatus: (message: string) => void, signal: AbortSignal | undefined) => Promise<T>;
  stop: () => Promise<void>;
}

/** A wallet's submit (the DApp connector API's), with the refusals it met kept for `repricing`. */
export interface RepricingPayments {
  /** Submits as the wallet does, keeping what a refusal was. */
  submit: (tx: string) => Promise<string>;
  /** PayingWallet's repricing, over this submit's refusals. */
  repricing: PayingWallet['repricing'];
}

/**
 * Payments over `walletSubmit` that run again after a fee refused as too low.
 * A refusal is kept as the wallet's own error (its code kept): the account
 * package reports a refused submit through midnight-js, which keeps only its
 * message. A payment that failed after a FEE_REPRICED refusal runs again, at
 * most once per larger margin the wallet can move to: the wallet holds the
 * raised margin for the rest of the command (RAISED_MARGIN_HOLD_MS), so the
 * later steps of a payment are priced with it too, and a re-run that makes a
 * step again can't go on making it. One that failed after a FEE_TOO_LOW, or a
 * FEE_REPRICED past those, reports that refusal.
 */
export function repricingPayments(walletSubmit: (tx: string) => Promise<string>): RepricingPayments {
  let lastRefusal: unknown;
  const submit = async (tx: string): Promise<string> => {
    try {
      const txHash = await walletSubmit(tx);
      lastRefusal = undefined;
      return txHash;
    } catch (err) {
      lastRefusal = err;
      throw err;
    }
  };
  const refusedFee = (err: unknown): boolean => isFeeRepriced(err) || isDustDoubleSpent(err) || (err as { code?: unknown } | null | undefined)?.code === FEE_TOO_LOW_CODE;
  const repricing = async <T>(pay: () => Promise<T>, onStatus: (message: string) => void, signal: AbortSignal | undefined): Promise<T> => {
    let repriced = 0;
    let doubleSpent = 0;
    try {
      return await rerunWhenRepriced(async () => {
        lastRefusal = undefined;
        return pay();
      }, () => (isFeeRepriced(lastRefusal) && repriced++ < DUST_FEE_MARGIN_STEPS.length - 1) || (isDustDoubleSpent(lastRefusal) && doubleSpent++ < DUST_DOUBLE_SPEND_RETRIES), onStatus, signal,
      () => (isDustDoubleSpent(lastRefusal) ? RERUN_DOUBLE_SPENT_STATUS : RERUN_REPRICED_STATUS));
    } catch (err) {
      throw refusedFee(lastRefusal) ? lastRefusal : err;
    }
  };
  return { submit, repricing };
}

/**
 * The payer's wallet for `target`, as the fee wallet of the account package's `connector` (the network engine's), keeping the SDK's warnings to the paying call's `sdkWarnings`. Stopping it stops the wallet.
 * `options` asks for the shielded side to be synced, which a deposit spends from (a network without shielded sync by default skips it otherwise).
 */
export async function openPayingWallet(payer: Payer, target: PayingTarget, connector: AccountChain['connector'], wallet: string | undefined, progress: Spinner, sdkWarnings: CallSdkWarnings, signal: AbortSignal | undefined, options?: ConnectOptions): Promise<PayingWallet> {
  const { feeWalletOver } = connector;
  const session = await payer.connect(target, wallet, progress, sdkWarnings, signal, options);
  const payments = repricingPayments((tx) => session.submit(tx));
  try {
    const feeWallet = await feeWalletOver({
      getShieldedAddresses: () => session.addresses(),
      balanceUnsealedTransaction: async (tx) => ({ tx: await session.balanceTransaction(tx) }),
      submitTransaction: payments.submit,
    });
    const shieldedBalance = async (tokenType: string): Promise<bigint> => (await session.balances()).shielded[tokenType] ?? 0n;
    progress.stop('Wallet ready');
    return { feeWallet, shieldedBalance, repricing: payments.repricing, stop: () => session.close() };
  } catch (err) {
    await session.close();
    throw err;
  }
}
