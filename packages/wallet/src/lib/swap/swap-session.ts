// What the swap operations that open a wallet share: the wallet's address
// mn keeps its open offers under, and the payer's session with the shielded
// side synced, closed whatever happens.

import type { Host, NetworkName, ConnectOptions, PayingTarget, CallSdkWarnings, WalletSession } from '@kuiralabs/midnight-cli-core';
import { resolveWalletPath, walletAddress } from '../wallet-config.ts';
import { stepSpinner, type PaidCallOptions } from '../wallet/paid-call.ts';

// A swap spends shielded coins only: its wallet syncs the shielded side on every network, stagenet included.
const SHIELDED: ConnectOptions = { shielded: true };

/** The unshielded address on `network` of mn's wallet `wallet` (a name or path; the active one when not given), which keys its open offers. */
export function offerWalletAddress(host: Host, root: string, wallet: string | undefined, network: NetworkName): Promise<string> {
  return walletAddress(resolveWalletPath(root, wallet), network, root, host);
}

/**
 * Runs `work` with the payer's wallet open as a session on the target's
 * network, its shielded side synced; opening it is the step "Opening the
 * wallet...". The session closes whatever happens, reverting what it built
 * but never submitted.
 */
export async function withSwapSession<T>(target: PayingTarget, options: PaidCallOptions, sdkWarnings: CallSdkWarnings, work: (session: WalletSession) => Promise<T>): Promise<T> {
  const session = await options.payer.connect(target, options.wallet, stepSpinner(options.onProgress, 'Opening the wallet...'), sdkWarnings, options.signal, SHIELDED);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}
