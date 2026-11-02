// Contract providers — lightweight provider setup for state queries.
// Deploy/call use the runner (generated scripts in dApp context) which build their own providers.

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { assertEndpointUsable } from '@kuiralabs/midnight-cli-core/lib/blockfrost';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import type { RawStateValue } from '@kuiralabs/midnight-cli-core/lib/engine';
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

/** A deployed contract's ledger state as plain JSON, read without its compiled contract; null when no contract is at `address`. */
export async function rawContractState(networkConfig: NetworkConfig, address: string): Promise<RawStateValue | null> {
  const found = await buildStateProvider(networkConfig).queryContractState(address);
  return found ? describeRawState(found.data.state) : null;
}
