// What every wallet operation of src/lib/wallet takes besides its own inputs,
// what it says once its wallet is open, and the wallet's address it acts on.

import type { NetworkChoice } from '@kuiralabs/midnight-cli-core/lib/network-target';
import type { ProgressEvent } from '@kuiralabs/midnight-cli-core/lib/progress';
import type { VerboseLog } from '@kuiralabs/midnight-cli-core/lib/verbose';
import type { CallSdkWarnings } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import type { HostEngines } from '@kuiralabs/midnight-cli-core/lib/engine';
import type { NetworkName } from '@kuiralabs/midnight-cli-core/lib/network';
import type { ResolvedSeed } from '../seed-resolver.ts';

/** The network, the endpoints and what a call gives a wallet operation; `Event` is what it says beyond its steps. */
export interface WalletCallOptions<Event = never> extends NetworkChoice {
  /** Cancels the operation: a call cancelled already starts nothing; one cancelled later stops with CancelledError. */
  signal?: AbortSignal;
  /** Each step, in today's words for a person, and the operation's own events. */
  onProgress?: (event: ProgressEvent | Event) => void;
  /** Diagnostic lines, as --verbose shows them. */
  log?: VerboseLog;
  /** The call's SDK warnings, kept off the terminal while the SDK runs; a call of the host's own when not given. */
  sdkWarnings?: CallSdkWarnings;
}

/** The operation's wallet is open and its work on the chain starts. */
export interface WalletOpened {
  readonly kind: 'wallet-opened';
  readonly network: NetworkName;
  /** The wallet's unshielded address on the network. */
  readonly address: string;
  /** Its shielded address on the network, when the wallet file has it saved. */
  readonly shieldedAddress?: string;
}

/** The network's pick of the endpoints `options` gives. */
export function networkChoiceOf(options: NetworkChoice): NetworkChoice {
  return { network: options.network, node: options.node, indexerWS: options.indexerWS, proofServer: options.proofServer };
}

/** The wallet's unshielded address on `network`: the one its file saved, else derived from its seed. */
export async function unshieldedAddressOf(wallet: ResolvedSeed, network: NetworkName, engines: HostEngines): Promise<string> {
  return wallet.config?.addresses[network] ?? (await engines.for(network)).keys.unshieldedAddress(wallet.seed, network);
}
