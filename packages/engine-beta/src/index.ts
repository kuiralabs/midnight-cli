// The engine for the SDK's beta set, which stagenet runs: the wallet SDK's
// 5.0 beta split packages, ledger 9 rc.3 and midnight-js 5 beta, as mn pins
// them.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Engine } from '@kuiralabs/midnight-cli-core/lib/engine';
import { assertOneSdkCopy } from '@kuiralabs/midnight-cli-core/lib/sdk-layout';
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

// The engine's folder (above src/ or dist/), and the SDK packages it declares:
// each must reach the engine's own copy of every WASM package.
const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_DEPENDENCIES = Object.keys((JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> }).dependencies)
  .filter((name) => /^@midnight(ntwrk|-ntwrk)\//.test(name));
assertOneSdkCopy("mn's beta engine", ENGINE_DIR, SDK_DEPENDENCIES, ['@midnightntwrk/ledger-v9', '@midnight-ntwrk/compact-runtime', '@midnightntwrk/onchain-runtime-v4']);

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
