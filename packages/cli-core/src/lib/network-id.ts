// Shared network id mapping: the one place that turns mn's network names and
// network configs into the network ids the SDK takes. The ids are the SDK's
// own NetworkId values, written as plain strings so the base needs no SDK; a
// test keeps them equal to the SDK's constants.

import type { NetworkName } from './network.ts';

/** A network id as the SDK takes it ("preprod", "preview", "stagenet", "undeployed"). */
export type MidnightNetworkId = 'preprod' | 'preview' | 'stagenet' | 'undeployed';

const NETWORK_ID_MAP: Record<string, MidnightNetworkId> = {
  PreProd: 'preprod',
  Preview: 'preview',
  StageNet: 'stagenet',
  Undeployed: 'undeployed',
};

const NETWORK_ID_BY_NAME: Record<NetworkName, MidnightNetworkId> = {
  preprod: 'preprod',
  preview: 'preview',
  stagenet: 'stagenet',
  undeployed: 'undeployed',
};

/**
 * Get the SDK network id from a network config string (e.g. 'Undeployed').
 * Throws if the networkId is unknown.
 */
export function getNetworkId(networkIdStr: string): MidnightNetworkId {
  const id = NETWORK_ID_MAP[networkIdStr];
  if (id === undefined) {
    throw new Error(`Unknown networkId: ${networkIdStr}`);
  }
  return id;
}

/** Get the SDK network id for one of mn's network names (e.g. 'undeployed'). */
export function networkIdForName(name: NetworkName): MidnightNetworkId {
  return NETWORK_ID_BY_NAME[name];
}
