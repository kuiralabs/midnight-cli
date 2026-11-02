// The engine for the SDK's release candidates (rc): the wallet SDK 2.0
// release candidates, ledger 9 and midnight-js 5 as mn pins them.

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
import { readOffer, spentNullifiers } from './offer-reader.ts';
import { rcWallet } from './wallet.ts';
import { SCRIPT_PACKAGES, generateCallScript, generateDeployScript, generateStateScript, packageFolder } from './contract-scripts.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { readShieldedBalanceCached, shieldedCoinPublicKeyHexFromSeed } from './shielded-direct-cache.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses, deriveShieldedAddressString, deriveUnshieldedAddress } from './derive-address.ts';

// The engine's folder (above src/ or dist/), and the SDK packages it declares:
// each must reach the engine's own copy of every WASM package.
const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_DEPENDENCIES = Object.keys((JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> }).dependencies)
  .filter((name) => /^@midnight(ntwrk|-ntwrk)\//.test(name));
assertOneSdkCopy("mn's rc engine", ENGINE_DIR, SDK_DEPENDENCIES, ['@midnightntwrk/ledger-v9', '@midnight-ntwrk/compact-runtime', '@midnightntwrk/onchain-runtime-v4']);

export const rcEngine: Engine = {
  set: 'rc',
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
    readOffer,
    spentNullifiers,
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
      // The compiler release whose contracts compact-runtime 0.20 runs (compactc 0.35.0 writes runtime-version 0.20.0).
      compiler: 'compactc 0.35',
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
  wallet: rcWallet,
};
