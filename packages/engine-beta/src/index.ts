// The engine for the SDK's beta set, which stagenet runs: the wallet SDK's
// 5.0 beta split packages, ledger 9 rc.3 and midnight-js 5 beta, as mn pins
// them.

import type { Engine } from '@kuiralabs/midnight-cli-core/lib/engine';
import * as ledger from '@midnightntwrk/ledger-v9';
import { checkRuntimeVersion, versionString as compactRuntimeVersion } from '@midnight-ntwrk/compact-runtime';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { blockLimitsOf } from './ledger-parameters.ts';
import { rawContractState } from './contract-providers.ts';
import { assertAddress } from './addresses.ts';
import { inspectTxHex } from './tx-inspect.ts';
import { betaWallet } from './wallet.ts';
import { SCRIPT_PACKAGES, generateCallScript, generateDeployScript, generateStateScript, packageFolder } from './contract-scripts.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { readShieldedBalanceCached, shieldedCoinPublicKeyHexFromSeed } from './shielded-direct-cache.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses, deriveShieldedAddressString, deriveUnshieldedAddress } from './derive-address.ts';

export const betaEngine: Engine = {
  set: 'beta',
  keys: {
    unshieldedAddress: deriveUnshieldedAddress,
    unshieldedAddresses: deriveAllAddresses,
    shieldedAddress: deriveShieldedAddressString,
    shieldedAddresses: deriveAllShieldedAddresses,
    dustPublicKeyHex: dustPublicKeyHexFromSeed,
    shieldedCoinPublicKeyHex: shieldedCoinPublicKeyHexFromSeed,
    assertAddress,
  },
  ledger: {
    blockLimits: blockLimitsOf,
    nightTokenId: () => ledger.unshieldedToken().raw,
    readTransaction: inspectTxHex,
  },
  contracts: {
    rawState: rawContractState,
    acceptsPrivateStatePassword(password) {
      try {
        validatePassword(password);
        return true;
      } catch {
        return false;
      }
    },
    scripts: {
      packages: SCRIPT_PACKAGES,
      packageFolder,
      compactRuntimeVersion,
      // The compiler release whose contracts compact-runtime 0.18 runs (compactc 0.33, built with --feature-zkir-v3).
      compiler: 'compactc 0.33',
      acceptsRuntime(runtimeVersion) {
        try {
          checkRuntimeVersion(runtimeVersion);
          return true;
        } catch {
          return false;
        }
      },
      deploy: generateDeployScript,
      call: generateCallScript,
      state: generateStateScript,
    },
  },
  readers: {
    shieldedBalance: readShieldedBalanceCached,
  },
  wallet: betaWallet,
};
