// The scripts mn runs in a dApp's own folder to deploy, call and read a
// contract with midnight-js, and the packages they import, for this engine's
// SDK set. What every set's script shares (the prelude that reports a
// failure, the client of mn serve's RPC, the argument and secret helpers,
// where the witnesses may be) comes from the runner as ScriptParts.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { CallScript, DeployScript, ScriptParts, StateScript } from '@kuiralabs/midnight-cli-core/engine';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';

/**
 * Every package a generated script imports, and the compact runtime the
 * user's compiled contract imports. Each is found by name from this engine's
 * location and linked into the dApp by name, so this works wherever the
 * packages sit (our checkout, our install, or someone else's hoisted tree).
 * A test keeps this list in step with the scripts' imports.
 */
export const SCRIPT_PACKAGES = [
  '@midnight-ntwrk/compact-js',
  '@midnight-ntwrk/compact-runtime',
  '@midnight-ntwrk/midnight-js-contracts',
  '@midnight-ntwrk/midnight-js-http-client-proof-provider',
  '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
  '@midnight-ntwrk/midnight-js-level-private-state-provider',
  '@midnight-ntwrk/midnight-js-network-id',
  '@midnight-ntwrk/midnight-js-node-zk-config-provider',
  '@midnight-ntwrk/midnight-js-types',
  '@midnight-ntwrk/midnight-js-utils',
  'ws',
] as const;

/** The folder of the installed package `name`, as mn resolves it; null when it isn't installed. */
export function packageFolder(name: string): string | null {
  // node:module's createRequire works in every host (Node, the test runner,
  // the bundle); a package exported to `import` only is found through
  // import.meta.resolve where the host has it.
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(name);
  } catch {
    try {
      entry = fileURLToPath(import.meta.resolve(name));
    } catch {
      return null;
    }
  }
  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name === name) return dir;
      } catch { /* not this one: keep looking up */ }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * SDK imports used by walletProviderCode and providerSetupCode. Kept out of
 * those fragments so a test can evaluate a fragment with the same bindings.
 */
export const PROVIDER_IMPORTS = `
import { createWalletProvider, createMidnightProvider, Transaction } from '@midnight-ntwrk/midnight-js-types';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
`;

/**
 * walletProvider + midnightProvider backed by mn serve RPC. midnight-js 5
 * passes version-tagged txs ({ version: 'v9', tx }) and refuses providers that
 * do not declare `supportedEras`; createWalletProvider/createMidnightProvider
 * declare v9 and unwrap/re-tag, so the bodies below see live ledger-v9 txs.
 */
export function walletProviderCode(): string {
  return `
const walletState = await rpcCall('getShieldedAddresses', {});

const walletProvider = createWalletProvider({
  getCoinPublicKey: () => walletState.shieldedCoinPublicKey,
  getEncryptionPublicKey: () => walletState.shieldedEncryptionPublicKey,
  // ttl is ignored: mn serve applies its own TTL when balancing.
  async balanceTx(tx) {
    const result = await rpcCall('balanceUnsealedTransaction', { tx: toHex(tx.serialize()) });
    return Transaction.deserialize('signature', 'proof', 'binding', fromHex(result.tx));
  },
});

const midnightProvider = createMidnightProvider(async (tx) => {
  await rpcCall('submitTransaction', { tx: toHex(tx.serialize()) });
  return tx.identifiers()[0];
});
`;
}

function contractSetupCode(contractName: string, managedDir: string, parts: ScriptParts): string {
  return `
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

const MANAGED_DIR = ${JSON.stringify(managedDir)};

// Load compiled contract class
const contractMod = await import(pathToFileURL(resolve(MANAGED_DIR, 'contract', 'index.js')).href);

// Try to load witnesses and private state factory.
// Both relative-to-cwd locations and contract/<...> locations are checked
// so mn dev (which chdirs into the contract sub-package) and mn contract
// deploy run from a workspace root both work.
const WITNESS_CANDIDATES = ${JSON.stringify(parts.witnessCandidates)};
let witnesses;
let createPrivateState;
for (const p of WITNESS_CANDIDATES) {
  try {
    const wMod = await import(pathToFileURL(resolve(p)).href);
    if (wMod.witnesses) { witnesses = wMod.witnesses; }
    // Look for createInitialPrivateState or create*PrivateState
    for (const key of Object.keys(wMod)) {
      if (typeof wMod[key] === 'function' && key.startsWith('create') && key.toLowerCase().includes('privatestate')) {
        createPrivateState = wMod[key];
      }
    }
    if (witnesses) break;
  } catch {}
}

// Note: callers (commands/contract.ts, commands/dev.ts) preflight when the
// contract's compiler-info declares witnesses, so a missing module here means
// the contract truly has no witnesses (vacant is correct). The runtime
// warning still names every path we tried — useful when the SDK later
// complains about a specific witness name despite preflight passing.
if (!witnesses) {
  process.stderr.write('Warning: No witnesses module found — using vacant witnesses. Searched:\\n');
  for (const p of WITNESS_CANDIDATES) process.stderr.write('  - ' + p + '\\n');
}

// Generate initial private state.
// Uses a deterministic seed derived from the wallet so post/takeDown use the same key.
// The private state provider (leveldb) persists between calls, but initialPrivateState
// is the fallback when no stored state exists yet.
${parts.privateStateSecretFn}
function makeInitialPrivateState() {
  if (createPrivateState) {
    // Secret precedence (see resolvePrivateStateSecretKey, injected above via
    // .toString()): an explicit mn --secret-key (from env MN_PRIVATE_STATE_SECRET,
    // never on disk) wins, else a deterministic key from the wallet's coin public
    // key so post/takeDown reuse it, else random.
    const secretKey = resolvePrivateStateSecretKey(
      process.env.MN_PRIVATE_STATE_SECRET,
      walletState?.shieldedCoinPublicKey,
    );
    try { return createPrivateState(secretKey); } catch {}
    try { return createPrivateState(); } catch {}
  }
  return {};
}

const compiled = witnesses
  ? CompiledContract.make(${JSON.stringify(contractName)}, contractMod.Contract).pipe(
      (c) => CompiledContract.withWitnesses(c, witnesses),
      (c) => CompiledContract.withCompiledFileAssets(c, MANAGED_DIR),
    )
  : CompiledContract.make(${JSON.stringify(contractName)}, contractMod.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      (c) => CompiledContract.withCompiledFileAssets(c, MANAGED_DIR),
    );
`;
}

/** The `providers` object deploy/call pass to midnight-js-contracts. */
export function providerSetupCode(networkConfig: NetworkConfig, privateStateKey: string, parts: ScriptParts): string {
  return `
const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: ${JSON.stringify(privateStateKey)},
    privateStoragePasswordProvider: () => Promise.resolve('mn-contract-default-pwd-16ch'),
    accountId: 'mn-contract-runner',
  }),
  publicDataProvider: indexerPublicDataProvider({
    queryURL: process.env.${parts.indexerUrlEnv},
    subscriptionURL: process.env.${parts.indexerWsUrlEnv},
  }),
  zkConfigProvider,
  proofProvider: httpClientProofProvider({ url: ${JSON.stringify(networkConfig.proofServer)}, zkConfigProvider }),
  walletProvider,
  midnightProvider,
};
`;
}

// ── Script generation ──

export function generateDeployScript(opts: DeployScript, parts: ScriptParts): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;
  // Constructor args are pre-serialized to JSON here (still in our process)
  // so the generated script just spreads them. The coerceArg helper inside
  // the bridge then upgrades number → BigInt and number[] → Uint8Array, the
  // two coercions Compact circuits invariably need.
  const argsLiteral = JSON.stringify(opts.args ?? []);

  return `${parts.prelude}
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${parts.rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir, parts)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${PROVIDER_IMPORTS}
${walletProviderCode()}
${providerSetupCode(opts.networkConfig, privateStateKey, parts)}

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

${parts.coerceArgFn}
const constructorArgs = (${argsLiteral}).map(coerceArg);
process.stderr.write('Deploying contract' + (constructorArgs.length ? ' with ' + constructorArgs.length + ' constructor arg(s)...' : '...') + '\\n');
const deployed = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
  args: constructorArgs,
});

const address = deployed.deployTxData?.public?.contractAddress ?? 'unknown';
process.stderr.write('Deploy complete: ' + address + '\\n');

console.log(JSON.stringify({ contractAddress: address }));
rpcClose();
process.exit(0);
`;
}

export function generateCallScript(opts: CallScript, parts: ScriptParts): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;

  return `${parts.prelude}
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${parts.rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir, parts)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${PROVIDER_IMPORTS}
${walletProviderCode()}
${providerSetupCode(opts.networkConfig, privateStateKey, parts)}

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

process.stderr.write('Finding deployed contract...\\n');
const deployed = await findDeployedContract(providers, {
  compiledContract: compiled,
  contractAddress: ${JSON.stringify(opts.contractAddress)},
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
});

process.stderr.write('Calling ${opts.circuit}...\\n');
${parts.coerceArgFn}
const args = (${JSON.stringify(opts.args ?? [])}).map(coerceArg);
await deployed.callTx.${opts.circuit}(...args);

console.log(JSON.stringify({ status: 'success', circuit: ${JSON.stringify(opts.circuit)} }));
rpcClose();
process.exit(0);
`;
}

export function generateStateScript(opts: StateScript, parts: ScriptParts): string {
  return `${parts.prelude}
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const MANAGED_DIR = ${JSON.stringify(opts.managedDir)};

// Load the contract module which exports the ledger() function
const contractMod = await import(pathToFileURL(resolve(MANAGED_DIR, 'contract', 'index.js')).href);

if (typeof contractMod.ledger !== 'function') {
  fail(new Error('Contract module does not export a ledger() function'));
}

process.stderr.write('Querying contract state...\\n');
const provider = indexerPublicDataProvider({
  queryURL: process.env.${parts.indexerUrlEnv},
  subscriptionURL: process.env.${parts.indexerWsUrlEnv},
});

const contractState = await provider.queryContractState(${JSON.stringify(opts.contractAddress)});
if (!contractState) {
  fail(new Error('No contract found at address ${opts.contractAddress}'));
}

process.stderr.write('Parsing ledger state...\\n');
// ledger() expects contractState.data (ChargedState), not the full ContractState
const state = contractMod.ledger(contractState.data ?? contractState);

// Extract scalar fields and map fields
const fields = {};
const maps = {};

for (const key of Object.keys(state)) {
  const val = state[key];

  // Check if it's a map-like (has size() and Symbol.iterator)
  if (val && typeof val === 'object' && typeof val.size === 'function') {
    try {
      maps[key] = { size: val.size().toString() };
    } catch {
      maps[key] = { size: '?' };
    }
  } else if (typeof val === 'bigint') {
    fields[key] = val.toString();
  } else if (typeof val === 'string') {
    fields[key] = val;
  } else if (typeof val === 'boolean') {
    fields[key] = String(val);
  } else if (val instanceof Uint8Array) {
    fields[key] = Array.from(val).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (val !== undefined && val !== null) {
    try { fields[key] = JSON.stringify(val); } catch { fields[key] = '?'; }
  }
}

console.log(JSON.stringify({ fields, maps }));
process.exit(0);
`;
}

