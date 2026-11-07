// Funding a wallet or an address from the genesis wallet (seed 0x01) of a
// local devnet: unshielded NIGHT from its unshielded coins, or shielded NIGHT
// from its shielded ones. Only the undeployed network has such a wallet; on
// preprod and preview a faucet or another wallet funds one.

import { type Host, throwIfCancelled, UsageError, type NetworkName, addressPrefix, looksLikeShieldedAddress, networkTargetOf, refuseOnMainnet, progressSteps, withCallSdkWarnings, nightAmountText, GENESIS_SEED, type HostEngines } from '@kuiralabs/midnight-cli-core';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui';
import { assertNetworkReady, explainProofFailure, type Receipt, RECEIPT_WAIT_MS } from '@kuiralabs/midnight-chain';
import { resolveWalletPath, saveShieldedAddress, walletAddress, walletShieldedAddress, type UnlockHost } from '../wallet-config.ts';
import { receiptOfSubmitted, saySyncPercent, submitSteps } from './submit-steps.ts';
import { networkChoiceOf, type WalletCallOptions } from './wallet-call.ts';

/**
 * Who an airdrop funds: a wallet by name or path (absent: the active one), at
 * its own address on the network; or an address (mn_addr_…, or
 * mn_shield-addr_…, which makes the airdrop shielded), no wallet file needed.
 */
export type AirdropRecipient = { wallet?: string } | { address: string };

/** The airdrop's recipient is resolved, and its work on the chain starts. */
export interface AirdropAddressed {
  readonly kind: 'airdrop-addressed';
  readonly network: NetworkName;
  /** The address it funds: shielded when the airdrop is. */
  readonly recipient: string;
  readonly shielded: boolean;
}

export interface AirdropNightOptions extends WalletCallOptions<AirdropAddressed> {
  to: AirdropRecipient;
  /** NIGHT to send, in its smallest unit; more than 0. */
  amount: bigint;
  /** Send shielded NIGHT, to the wallet's shielded address (implied by a shielded address in `to`). */
  shielded?: boolean;
  /** How long to wait for the indexer to list the transaction, in milliseconds: RECEIPT_WAIT_MS when not given; 0 does not wait. */
  receiptWaitMs?: number;
}

/** A submitted airdrop. */
export interface NightAirdrop {
  readonly network: NetworkName;
  /** The transaction's identifier (`midnight tx status` takes it). */
  readonly txHash: string;
  /** The address it funded: shielded when the airdrop was. */
  readonly recipient: string;
  readonly shielded: boolean;
  /** The transaction once the indexer lists it, or why it is missing; absent when `receiptWaitMs` is 0. */
  readonly receipt?: Receipt;
}

/**
 * Sends `amount` NIGHT from the local devnet's genesis wallet to `to`: syncs
 * the genesis wallet, submits, and waits for the indexer to list the
 * transaction. Refused on any network but undeployed. A wallet file given a
 * shielded airdrop keeps its shielded address.
 */
export async function airdropNight(host: Host, options: AirdropNightOptions): Promise<NightAirdrop> {
  const { signal, onProgress, amount } = options;
  const receiptWaitMs = options.receiptWaitMs ?? RECEIPT_WAIT_MS;
  throwIfCancelled(signal);
  if (amount <= 0n) throw new UsageError(`Invalid amount: ${nightAmountText(amount)} NIGHT — must be greater than 0`);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));

  refuseOnMainnet(network, 'Airdrop', 'mainnet has no faucet and no genesis wallet to fund from', 'Fund a mainnet wallet by transferring NIGHT to it from another wallet.');
  if (network !== 'undeployed') {
    throw new Error(
      `Airdrop is only available on the "undeployed" network (local devnet).\n` +
      `Current network: "${network}"\n` +
      `On preprod/preview, use a faucet or transfer from another wallet.`
    );
  }

  // A shielded address prefix is unambiguous: it makes the airdrop shielded
  // without being asked twice. The reverse (shielded with an unshielded
  // address) is a real contradiction, refused in addressDestination.
  const shielded = options.shielded === true || ('address' in options.to && looksLikeShieldedAddress(options.to.address));
  const destination = await resolveDestination(host, root, network, options.to, shielded);
  // A wallet file keeps the shielded address it is funded at, so later reads skip deriving it.
  if (destination.walletPath !== undefined) saveShieldedAddress(destination.walletPath, network, destination.address);
  const recipient = destination.address;
  onProgress?.({ kind: 'airdrop-addressed', network, recipient, shielded });

  const steps = progressSteps(onProgress);
  const text = nightAmountText(amount);
  const txHash = await withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => {
    if (!shielded) {
      steps.start('Starting genesis wallet...');
      // A ledger-9 chain, and the indexer, the node and the proof server answer, before the sync and the proof.
      await assertNetworkReady(network, networkConfig, { proofServer: true }, { signal });
      return (await (await host.engines.for(network)).wallet.airdrop({
        root,
        notice: host.notice,
        networkConfig,
        recipientAddress: recipient,
        amount,
        signal,
        log: options.log,
        sdkWarnings,
        onSync: (applied, highest) => {
          if (highest > 0) steps.update(`Syncing genesis wallet... ${Math.round((applied / highest) * 100)}%`);
        },
        onDust: (status) => steps.update(`Dust: ${status}`),
        ...submitSteps(steps),
        onSyncWarning: (_tag, message) => steps.update(`Syncing genesis wallet... (${message}, retrying)`),
      })).txHash;
    }

    // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
    const stopListening = sdkWarnings.listen(undefined);
    try {
      steps.start('Syncing genesis wallet...');
      await assertNetworkReady(network, networkConfig, { proofServer: true }, { signal });
      return await (await host.engines.for(network)).wallet.shieldedTransfer({
        seed: Buffer.from(GENESIS_SEED, 'hex'),
        root,
        notice: host.notice,
        network,
        networkConfig,
        recipient,
        amount,
        progress: silentSpinner(steps.update),
        waitForDustToCover: false,
        insufficient: (available) =>
          `Genesis wallet has insufficient shielded balance: ${available} NIGHT available, ${text} NIGHT requested`,
        log: options.log,
        signal,
        onStatus: (status) => steps.update(status),
        onSyncProgress: (applied, highest) => saySyncPercent(steps, 'Syncing genesis wallet', applied, highest),
        onSyncDetail: (detail) => steps.update(`Syncing genesis wallet... (waiting on: ${detail})`),
      });
    } finally {
      stopListening();
    }
  }).catch(async (err: unknown) => { throw await explainProofFailure(err, networkConfig.proofServer, signal); });

  const receipt = await receiptOfSubmitted(networkConfig.indexer, txHash, steps, signal, receiptWaitMs);
  return { network, txHash, recipient, shielded, ...(receipt === undefined ? {} : { receipt }) };
}

/** Where an airdrop goes: its address, and the wallet file to keep it when it is a wallet's shielded address. */
interface Destination {
  readonly address: string;
  readonly walletPath?: string;
}

async function resolveDestination(host: UnlockHost, root: string, network: NetworkName, to: AirdropRecipient, shielded: boolean): Promise<Destination> {
  if ('address' in to) return { address: await addressDestination(to.address, host.engines, network, shielded) };

  // A wallet file: by name, by path, or the active one.
  const walletPath = resolveWalletPath(root, to.wallet);

  if (shielded) {
    // The wallet's own shielded address, as its file keeps it: receiving needs no passphrase
    // (unless the network was added after the wallet was written).
    const stored = await walletShieldedAddress(walletPath, network, root, host);
    if (stored === undefined) throw new Error(`Wallet ${walletPath} keeps no shielded address for ${network}.`);
    return { address: await addressDestination(stored, host.engines, network, true), walletPath };
  }

  return { address: await walletAddress(walletPath, network, root, host) };
}

/** `address`, checked to be one of the airdrop's kind on the network. */
async function addressDestination(address: string, engines: HostEngines, network: NetworkName, shielded: boolean): Promise<string> {
  const looksShielded = looksLikeShieldedAddress(address);

  // The inverse mismatch (a shielded address, not asked for shielded) never
  // reaches here: airdropNight infers shielded from the prefix.
  if (shielded && !looksShielded) {
    throw new Error(
      `--shielded was passed but --wallet is an unshielded address.\n` +
      `Pass a shielded address (mn_shield-addr_...) or drop --shielded.\n` +
      `Got: ${address}`
    );
  }

  const expectedPrefix = addressPrefix(shielded ? 'shielded' : 'unshielded', network);

  if (!address.startsWith(expectedPrefix)) {
    throw new Error(
      `Address does not match network "${network}".\n` +
      `Expected prefix: ${expectedPrefix}\n` +
      `Got: ${address}`
    );
  }

  if (shielded) {
    try {
      (await engines.for(network)).keys.assertAddress(address, 'shielded', network);
    } catch (err: any) {
      throw new Error(`Invalid shielded address: ${err.message}`);
    }
  }
  return address;
}
