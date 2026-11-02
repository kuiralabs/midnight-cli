// The engine for the SDK's release candidates (rc): the wallet SDK 2.0
// release candidates, ledger 9 and midnight-js 5 as mn pins them.

import type { Engine } from '../../lib/engine.ts';
import { blockLimitsOf } from './ledger-parameters.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { shieldedCoinPublicKeyHexFromSeed } from './shielded-direct-cache.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses, deriveShieldedAddressString, deriveUnshieldedAddress } from './derive-address.ts';

export const rcEngine: Engine = {
  set: 'rc',
  keys: {
    unshieldedAddress: deriveUnshieldedAddress,
    unshieldedAddresses: deriveAllAddresses,
    shieldedAddress: deriveShieldedAddressString,
    shieldedAddresses: deriveAllShieldedAddresses,
    dustPublicKeyHex: dustPublicKeyHexFromSeed,
    shieldedCoinPublicKeyHex: shieldedCoinPublicKeyHexFromSeed,
  },
  ledger: {
    blockLimits: blockLimitsOf,
  },
};
