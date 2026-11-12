// Reading a deployed contract's ledger state: parsed into its fields by the
// state script, run in the dApp's folder with its compiled contract, or, when
// that can't run (no compiled contract there, a script that fails), the
// untyped state tree the indexer holds for the address.

import { type Host, CancelledError, ContractStateUnreadableError, throwIfCancelled, type NetworkName, networkTargetOf, type NetworkChoice, progressSteps, type ProgressEvent, untilCancelled, type RawStateValue } from '@kuiralabs/midnight-cli-core';
import { networkChoiceOf } from '@kuiralabs/midnight-wallet';
import { assertEndpointsReachable, endpointsOf } from '@kuiralabs/midnight-chain';
import { findContractInfo } from './inspect.ts';
import { validateContractAddress } from './validate.ts';

/** No contract is deployed at the address on the network. */
export class ContractNotFoundError extends Error {
  readonly code = 'CONTRACT_NOT_FOUND';

  constructor(address: string, network: NetworkName) {
    super(`No contract found at address ${address} on ${network}: check the address and the network (a local chain that was reset holds none of its earlier contracts).`);
    this.name = 'ContractNotFoundError';
    Object.setPrototypeOf(this, ContractNotFoundError.prototype);
  }
}

/** The address is one and the network is known: the state is read next. */
export interface StateReading {
  readonly kind: 'state-reading';
  readonly network: NetworkName;
}

/** The parsed state couldn't be read: the query's step ends here, and the raw state is read instead. */
export interface StateFallback {
  readonly kind: 'fallback';
  /** Why the state script didn't give the parsed state. */
  readonly reason: string;
}

export interface ReadContractStateOptions extends NetworkChoice {
  /** The dApp's root, where the state script runs. */
  dappDir: string;
  /** Where contract-info.json is looked for, when not in `dappDir`. */
  scanDir?: string;
  /** Which of the dApp's compiled contracts, when it has more than one. */
  name?: string;
  /** The contract's address, 64 hex characters. */
  address: string;
  /** Cancels the read: a call cancelled already starts nothing; one cancelled later stops with CancelledError, without the raw fallback. */
  signal?: AbortSignal;
  /** Each step, in today's words for a person, and the read's own events. */
  onProgress?: (event: ProgressEvent | StateReading | StateFallback) => void;
}

/** A contract's ledger state, parsed by its compiled contract: its scalar fields as text, its maps by size. */
export interface ParsedContractState {
  readonly kind: 'parsed';
  readonly network: NetworkName;
  readonly address: string;
  readonly fields: Record<string, string>;
  /** Each map by its entry count (a number, as JSON_CONTRACT has it); null when the contract's map couldn't say. */
  readonly maps: Record<string, { size: number | null }>;
}

/** A contract's untyped state tree, as the indexer holds it. */
export interface RawContractState {
  readonly kind: 'raw';
  readonly network: NetworkName;
  readonly address: string;
  readonly raw: RawStateValue;
}

export type ContractState = ParsedContractState | RawContractState;

/**
 * The state of the contract at `address`: parsed by the compiled contract
 * found from `scanDir` (else `dappDir`), or, when that fails, the raw state
 * (a 'fallback' event says so first). No contract at the address fails.
 */
export async function readContractState(host: Host, options: ReadContractStateOptions): Promise<ContractState> {
  const { dappDir, address, signal, onProgress } = options;
  throwIfCancelled(signal);
  validateContractAddress(address);
  const { runState } = await import('./runner.ts');
  const { network, root, networkConfig } = networkTargetOf(host, networkChoiceOf(options));
  onProgress?.({ kind: 'state-reading', network });

  const steps = progressSteps(onProgress);
  steps.start('Querying contract state...');
  // The state is read from the indexer: it answers first, or the read fails at once naming it.
  await assertEndpointsReachable(endpointsOf(networkConfig, { node: false }), { signal });
  try {
    const { info } = findContractInfo(options.scanDir ?? dappDir, options.name);
    const { fields, maps } = await runState({
      dappDir,
      network,
      root,
      engines: host.engines,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      onMessage: (msg) => steps.update(msg),
      signal,
    });
    steps.done('State retrieved');
    return { kind: 'parsed', network, address, fields, maps };
  } catch (err) {
    // A cancelled read stops here; it doesn't fall back to the raw state, nor does a state the ledger can't decode (the raw read would fail the same).
    if (err instanceof CancelledError || err instanceof ContractStateUnreadableError) throw err;
    throwIfCancelled(signal);
    onProgress?.({ kind: 'fallback', reason: err instanceof Error ? err.message : String(err) });
  }

  // The engine's query takes no signal: the call stops waiting for it when cancelled.
  const raw = await untilCancelled((await host.engines.for(network)).contracts.rawState(networkConfig, address), signal);
  if (!raw) throw new ContractNotFoundError(address, network);
  return { kind: 'raw', network, address, raw };
}
