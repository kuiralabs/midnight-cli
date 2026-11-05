// The engine for the SDK's release candidates (rc): the wallet SDK 2.0
// release candidates, ledger 9 and midnight-js 5 as mn pins them.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Engine, type EngineHost, assertOneSdkCopy } from '@kuiralabs/midnight-cli-core/engine';
import type { RcEngineOptions } from './index.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { checkRuntimeVersion, versionString as compactRuntimeVersion } from '@midnight-ntwrk/compact-runtime';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { blockLimitsOf } from './ledger-parameters.ts';
import { rawContractState } from './contract-providers.ts';
import { assertAddress } from './addresses.ts';
import { inspectTxHex } from './tx-inspect.ts';
import { readOffer, spentNullifiers } from './offer-reader.ts';
import { createRcWallet } from './wallet.ts';
import { WalletDataRepository, type RepoDeps } from './wallet-data-repository.ts';
import { SCRIPT_PACKAGES, generateCallScript, generateDeployScript, generateStateScript, packageFolder } from './contract-scripts.ts';
import { dustPublicKeyHexFromSeed } from './dust-direct-cache.ts';
import { readShieldedBalanceCached, shieldedCoinPublicKeyHexFromSeed } from './shielded-direct-cache.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses, deriveShieldedAddressString, deriveUnshieldedAddress } from './derive-address.ts';

// The account package, whose Midnight libraries are peer dependencies: each
// engine declares it, and its copy in the engine's install resolves them to
// the engine's own SDK set.
const ACCOUNT_PACKAGE = '@kuiralabs/midnight-account-chain';

// The engine's folder (above src/ or dist/), and the SDK packages it declares
// with the account package: each must reach the engine's own copy of every
// WASM package.
const ENGINE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SDK_DEPENDENCIES = Object.keys((JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> }).dependencies)
  .filter((name) => /^@midnight(ntwrk|-ntwrk)\//.test(name) || name === ACCOUNT_PACKAGE);
assertOneSdkCopy("mn's rc engine", ENGINE_DIR, SDK_DEPENDENCIES, ['@midnightntwrk/ledger-v9', '@midnight-ntwrk/compact-runtime', '@midnightntwrk/onchain-runtime-v4']);

export type { RcEngineOptions } from './index.ts';

/**
 * The rc engine for a host: its own wallet repository (the in-memory caches),
 * reading the host's settings and telling the host's notices. Each host gets
 * one of its own; the work every engine does alike is shared.
 */
export function createRcEngine(host: EngineHost, options: RcEngineOptions = {}): Engine {
  return { ...SHARED, wallet: createRcWallet(new WalletDataRepository(host, options.repository)) };
}

// The parts that keep no state: the same for every host's engine.
const SHARED: Omit<Engine, 'wallet'> = {
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
  // Imported from this engine's folder, so the copy is the one its install gives it.
  async account() {
    const [artefacts, connector, context, contract, deposit, errors, owner] = await Promise.all([
      import('@kuiralabs/midnight-account-chain/artefacts'),
      import('@kuiralabs/midnight-account-chain/connector'),
      import('@kuiralabs/midnight-account-chain/context'),
      import('@kuiralabs/midnight-account-chain/contract'),
      import('@kuiralabs/midnight-account-chain/deposit'),
      import('@kuiralabs/midnight-account-chain/errors'),
      import('@kuiralabs/midnight-account-chain/owner'),
    ]);
    return { artefacts, connector, context, contract, deposit, errors, owner };
  },
};
