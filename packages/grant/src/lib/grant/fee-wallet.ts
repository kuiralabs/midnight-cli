// The wallet a paying `mn grant` command pays with: the payer's wallet in this
// process, made into the account package's fee wallet.

import type { FeeWallet } from '@kuiralabs/midnight-account-chain/owner';
import type { AccountChain } from './account-chain.ts';
import { type ConnectOptions, type Payer, type PayingTarget, type CallSdkWarnings, DUST_FEE_MARGIN_STEPS, FEE_TOO_LOW_CODE, isFeeRepriced, rerunWhenRepriced } from '@kuiralabs/midnight-cli-core';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui';

/** A fee wallet in this process, and how to stop it. */
export interface PayingWallet {
  feeWallet: FeeWallet;
  /** What the synced wallet holds shielded of the token whose raw type is `tokenType`, in its smallest unit. */
  shieldedBalance: (tokenType: string) => Promise<bigint>;
  /**
   * Runs a payment, and again when its submit was refused because the node
   * took its fee as too low and the wallet now prices with a larger margin
   * (FEE_REPRICED), saying so through `onStatus`. The account package carries
   * on from the step it recorded, so steps that landed are not made again.
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
 * message. A payment that failed after a FEE_REPRICED refusal runs again,
 * while the wallet has larger margins left since a transaction last went
 * through (each step of a deploy can be repriced in turn); one that failed
 * after a FEE_TOO_LOW, or a FEE_REPRICED past them, reports that refusal.
 */
export function repricingPayments(walletSubmit: (tx: string) => Promise<string>): RepricingPayments {
  let lastRefusal: unknown;
  let repricedSinceLanded = 0;
  const submit = async (tx: string): Promise<string> => {
    try {
      const txHash = await walletSubmit(tx);
      lastRefusal = undefined;
      repricedSinceLanded = 0;
      return txHash;
    } catch (err) {
      lastRefusal = err;
      if (isFeeRepriced(err)) repricedSinceLanded++;
      throw err;
    }
  };
  const refusedFee = (err: unknown): boolean => isFeeRepriced(err) || (err as { code?: unknown } | null | undefined)?.code === FEE_TOO_LOW_CODE;
  const repricing = async <T>(pay: () => Promise<T>, onStatus: (message: string) => void, signal: AbortSignal | undefined): Promise<T> => {
    try {
      return await rerunWhenRepriced(async () => {
        lastRefusal = undefined;
        return pay();
      }, () => isFeeRepriced(lastRefusal) && repricedSinceLanded < DUST_FEE_MARGIN_STEPS.length, onStatus, signal);
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
