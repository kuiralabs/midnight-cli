// Reading bech32m addresses as the SDK's address types, for the network they
// must be on.

import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { networkIdForName } from '@kuiralabs/midnight-cli-core/engine';
import type { NetworkName } from '@kuiralabs/midnight-cli-core';

/** A shielded address on `network`, as the SDK reads it. Throws when it is not one. */
export function decodeShieldedAddress(address: string, network: NetworkName): ShieldedAddress {
  return MidnightBech32m.parse(address).decode(ShieldedAddress, networkIdForName(network));
}

/** An unshielded address on `network`, as the SDK reads it. Throws when it is not one. */
export function decodeUnshieldedAddress(address: string, network: NetworkName): UnshieldedAddress {
  return MidnightBech32m.parse(address).decode(UnshieldedAddress, networkIdForName(network));
}

/** Throws, saying why, unless `address` is an address of that kind on `network`. */
export function assertAddress(address: string, kind: 'shielded' | 'unshielded', network: NetworkName): void {
  if (kind === 'shielded') decodeShieldedAddress(address, network);
  else decodeUnshieldedAddress(address, network);
}
