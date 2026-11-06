// Contract providers — lightweight provider setup for state queries.
// Deploy/call use the runner (generated scripts in dApp context) which build their own providers.

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { RawStateValue } from '@kuiralabs/midnight-cli-core/engine';
import { assertEndpointUsable, type NetworkConfig } from '@kuiralabs/midnight-cli-core';
import { ContractState } from '@midnightntwrk/ledger-v9';
import { ContractState as ContractStateV8 } from '@midnight-ntwrk/ledger-v8';
import { describeRawState } from './raw-state.ts';

/**
 * Build a lightweight indexer-only provider for state queries.
 * No wallet or proof server needed.
 */
export function buildStateProvider(networkConfig: NetworkConfig) {
  assertEndpointUsable(networkConfig.indexer);
  return indexerPublicDataProvider({
    queryURL: networkConfig.indexer,
    subscriptionURL: networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'),
  });
}

/**
 * A deployed contract's ledger state as plain JSON, read without its compiled
 * contract; null when no contract is at `address`. The indexer hands the state
 * over as the bytes its ledger wrote: a contract deployed before the ledger-9
 * fork keeps a ledger-8 state, so both ledgers' decoders are offered.
 */
export async function rawContractState(networkConfig: NetworkConfig, address: string): Promise<RawStateValue | null> {
  const found = await buildStateProvider(networkConfig).queryContractState(address);
  if (!found) return null;
  return describeRawState(found.contractState.deserialize({ v9: ContractState, v8: ContractStateV8 }).data.state);
}
