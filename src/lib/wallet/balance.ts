// What an address or a wallet holds. An address's balance is its unshielded
// tokens, read from the indexer without a wallet; a wallet's adds its shielded
// NIGHT and tokens, read with its secret keys, where the network has a
// shielded faucet (or when asked).

import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { throwIfCancelled, UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { isValidNetworkName, type NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import { networkTargetOf } from '@kuiralabs/midnight-cli-core/lib/network-target';
import { progressSteps } from '@kuiralabs/midnight-cli-core/lib/progress';
import { withCallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { shieldedSyncEnabled } from '@kuiralabs/midnight-cli-core/lib/shielded-policy';
import { assertLedgerSupported, fetchProtocolVersion } from '@kuiralabs/midnight-chain/lib/ledger-guard';
import { getChainGenesisHash } from '@kuiralabs/midnight-chain/lib/chain-id';
import { saveShieldedAddress } from '../wallet-config.ts';
import { seedOf, type WalletSource } from '../seed-resolver.ts';
import { createEtaEstimator, formatSyncStatus } from '../sync-eta.ts';
import { networkChoiceOf, unshieldedAddressOf, type WalletCallOptions, type WalletOpened } from './wallet-call.ts';

/** An address's unshielded tokens. */
export interface AddressBalance {
  readonly address: string;
  readonly network: NetworkName;
  /** Each token's balance by its raw type, in its smallest unit; NIGHT is under the native token's type. */
  readonly balances: ReadonlyMap<string, bigint>;
  readonly utxoCount: number;
  readonly txCount: number;
}

export interface ReadAddressBalanceOptions extends Omit<WalletCallOptions, 'sdkWarnings'> {
  /** Read past every cache, from the indexer. */
  forceFresh?: boolean;
}

/**
 * The network to read `address` on: `network` when given, else the one its
 * prefix names (`mn_addr_<network>1…`), else undefined (the saved network).
 * Throws UsageError when the two differ: the indexer would refuse the address.
 */
export function addressNetwork(address: string, network?: NetworkName): NetworkName | undefined {
  const inferred = inferNetworkFromAddress(address);
  if (network && inferred && network !== inferred) {
    throw new UsageError(
      `Address belongs to ${inferred} but --network is ${network}.\n` +
      `Drop --network (we'll infer from the address) or pass an address for ${network}.`
    );
  }
  return network ?? inferred ?? undefined;
}

/** The network an address's prefix names, or null when it names none. */
function inferNetworkFromAddress(address: string): NetworkName | null {
  const match = address.match(/^mn_addr_([a-z]+)1/);
  if (!match) return null;
  const candidate = match[1];
  return isValidNetworkName(candidate) ? candidate : null;
}

/**
 * The unshielded balance of `address`, from the indexer through mn's cache,
 * on the network its prefix names unless `options.network` says another
 * (refused when they differ).
 */
export async function readAddressBalance(host: Host, address: string, options: ReadAddressBalanceOptions = {}): Promise<AddressBalance> {
  const { signal, log } = options;
  throwIfCancelled(signal);
  const { network, networkConfig } = networkTargetOf(host, { ...networkChoiceOf(options), network: addressNetwork(address, options.network) });
  const steps = progressSteps(options.onProgress);
  steps.start(`Checking balance on ${network}...`);
  const result = await (await host.engines.for(network)).wallet.unshieldedBalance(address, networkConfig, {
    forceFresh: options.forceFresh,
    signal,
    log,
    onProgress: (current, highest) => {
      if (highest > 0) steps.update(`Syncing transactions... ${Math.round((current / highest) * 100)}%`);
    },
  });
  steps.done(`Synced ${result.txCount} transactions`);
  return { address, network, balances: result.balances, utxoCount: result.utxoCount, txCount: result.txCount };
}

/** A wallet's shielded holdings. */
export interface ShieldedHoldings {
  /** NIGHT, in its smallest unit. */
  readonly night: bigint;
  /** Spendable NIGHT coins. */
  readonly availableCoins: number;
  /** Shielded tokens other than NIGHT, by raw type (sorted), in their smallest units. */
  readonly tokens: ReadonlyMap<string, bigint>;
}

/** What a wallet holds on a network. */
export interface WalletBalance {
  readonly network: NetworkName;
  /** Its unshielded address. */
  readonly address: string;
  /** Its shielded address: derived when the shielded balance was read, else the one its file saved, if any. */
  readonly shieldedAddress?: string;
  readonly unshielded: { readonly night: bigint; readonly utxoCount: number };
  /** Null when the shielded balance was not read: the network has no shielded faucet, and `forceShielded` was not given. */
  readonly shielded: ShieldedHoldings | null;
}

/** The wallet's unshielded NIGHT is read, before its shielded balance is. */
export interface UnshieldedRead {
  readonly kind: 'unshielded-read';
  /** NIGHT, in its smallest unit. */
  readonly night: bigint;
  readonly utxoCount: number;
}

export interface ReadWalletBalanceOptions extends WalletCallOptions<WalletOpened | UnshieldedRead> {
  /** Read past every cache, from the indexer. */
  forceFresh?: boolean;
  /** Read the shielded balance even where the network has no shielded faucet. */
  forceShielded?: boolean;
}

/**
 * What a wallet holds: its unshielded NIGHT from the indexer, then its
 * shielded NIGHT and tokens with its secret keys (mn's reader of the
 * indexer's events, through its cache), where the network has a shielded
 * faucet or `forceShielded` says. A wallet file is given its shielded address.
 */
export async function readWalletBalance(host: Host, source: WalletSource, options: ReadWalletBalanceOptions = {}): Promise<WalletBalance> {
  const { signal, log, onProgress } = options;
  const forceFresh = options.forceFresh === true;
  throwIfCancelled(signal);
  const { network, networkConfig, root } = networkTargetOf(host, networkChoiceOf(options));
  log?.('balance', `network=${network} indexerWS=${networkConfig.indexerWS}`);
  const wallet = await seedOf(host, source);
  log?.('balance', `wallet path=${wallet.walletPath ?? '(from --seed/MN_SEED)'}`);
  const engine = await host.engines.for(network);
  const address = await unshieldedAddressOf(wallet, network, host.engines);
  const savedShieldedAddress = wallet.config?.shieldedAddresses?.[network] || undefined;
  const nightToken = engine.ledger.nightTokenId();
  const steps = progressSteps(onProgress);

  return withCallSdkWarnings(host.sdkWarnings, options.sdkWarnings, async (sdkWarnings) => {
    // Keep the SDK's transient errors and RPC noise off the terminal while this runs.
    const stopListening = sdkWarnings.listen(undefined);
    try {
      onProgress?.({ kind: 'wallet-opened', network, address, ...(savedShieldedAddress === undefined ? {} : { shieldedAddress: savedShieldedAddress }) });

      // Unshielded first, from the indexer alone: no proof server, under a second on most networks.
      steps.start('Checking unshielded...');
      log?.('balance', `phase=unshielded forceFresh=${forceFresh}`);
      const unshieldedResult = await engine.wallet.unshieldedBalance(address, networkConfig, { forceFresh, signal, log });
      const unshielded = { night: unshieldedResult.balances.get(nightToken) ?? 0n, utxoCount: unshieldedResult.utxoCount };
      log?.('balance', `unshielded fromCache=${unshieldedResult.fromCache} utxos=${unshielded.utxoCount} txs=${unshieldedResult.txCount}`);
      steps.done('Unshielded ready');
      onProgress?.({ kind: 'unshielded-read', ...unshielded });

      // The shielded read is the slow part; skipping it where shielded is
      // unusable (no faucet on preview/preprod) makes those reads near-instant.
      if (!shieldedSyncEnabled(network, options.forceShielded)) {
        return { network, address, ...(savedShieldedAddress === undefined ? {} : { shieldedAddress: savedShieldedAddress }), unshielded, shielded: null };
      }

      steps.start('Syncing shielded...');
      const eta = createEtaEstimator();
      // The shielded address is key derivation alone; a wallet file keeps it for next time.
      const shieldedAddress = engine.keys.shieldedAddress(wallet.seed, network);
      if (wallet.walletPath) saveShieldedAddress(wallet.walletPath, network, shieldedAddress);

      // mn's reader replays the indexer's zswap events with the full secret
      // keys (receives and spends) into a cache: ~50-70 s the first time on a
      // hosted network, incremental after. The chain id drops the cache when
      // the chain was reset.
      await assertLedgerSupported(network, networkConfig, fetchProtocolVersion, signal);
      // Null when the node can't say (the cache check is then skipped); a cancelled call stops here.
      const chainId = (await getChainGenesisHash(networkConfig.node, signal)) ?? undefined;
      const shieldedResult = await engine.readers.shieldedBalance(wallet.seed, network, networkConfig.indexerWS, {
        root,
        forceFresh,
        chainId,
        signal,
        onProgress: (applied, highest) => steps.update(formatSyncStatus(eta.sample({ applied, highest, t: Date.now() }), 'Syncing shielded')),
      });
      steps.done('Shielded ready');
      return {
        network,
        address,
        shieldedAddress,
        unshielded,
        shielded: { night: shieldedResult.balance, availableCoins: shieldedResult.availableCoins, tokens: shieldedResult.tokens },
      };
    } finally {
      stopListening();
    }
  });
}
