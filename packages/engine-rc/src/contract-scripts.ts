// The scripts mn runs in a dApp's own folder to deploy, call and read a
// contract with midnight-js, and the packages they import, for this engine's
// SDK set. What every set's script shares (the prelude that reports a
// failure, the client of mn serve's RPC, the argument and secret helpers,
// where the witnesses may be) comes from the runner as ScriptParts.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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
  '@midnight-ntwrk/midnight-js-node-zk-config-provider',
  '@midnight-ntwrk/midnight-js-types',
  '@midnight-ntwrk/midnight-js-utils',
  '@midnightntwrk/ledger-v9',
  'ws',
] as const;

/**
 * The folder of the installed package `name`, as mn resolves it from `from`
 * (this engine's module); null when it isn't installed.
 */
export function packageFolder(name: string, from: string = import.meta.url): string | null {
  // node:module's createRequire works in every host (Node, the test runner,
  // the bundle); a package exported to `import` only is found through
  // import.meta.resolve where the host has it. bun answers some names (ws)
  // with a module of its own, not a file: those are looked up in the
  // node_modules folders above this module, where the script finds them too.
  let entry: string | undefined;
  try {
    entry = createRequire(from).resolve(name);
  } catch {
    try {
      entry = fileURLToPath(import.meta.resolve(name));
    } catch { /* not resolvable here: looked up below */ }
  }
  if (entry === undefined || !isAbsolute(entry)) return installedFolder(name, dirname(fileURLToPath(from)));
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

/** The package `name` in the nearest node_modules above `dir` that holds it, as Node's resolution walks; null when none does. */
function installedFolder(name: string, dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    const folder = join(at, 'node_modules', name);
    if (existsSync(join(folder, 'package.json'))) return folder;
    if (dirname(at) === at) return null;
  }
}

/**
 * SDK imports used by walletProviderCode and providerSetupCode. Kept out of
 * those fragments so a test can evaluate a fragment with the same bindings.
 */
export const PROVIDER_IMPORTS = `
import { createLedger9WalletProvider, createLedger9MidnightProvider } from '@midnight-ntwrk/midnight-js-types';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import * as mnFs from 'node:fs';
import * as mnPath from 'node:path';
`;

/**
 * walletProvider + midnightProvider backed by mn serve RPC. midnight-js 5
 * hands providers transaction handles (bytes tagged with their ledger era) and
 * refuses providers that don't say which eras they serve; the ledger-9
 * builders declare v9. The wallet answers a balance with the transaction's
 * bytes, and a submit returns the transaction's id, read from the transaction
 * decoded with this script's ledger.
 */
export function walletProviderCode(): string {
  return `
const walletState = await rpcCall('getShieldedAddresses', {});

const walletProvider = createLedger9WalletProvider({
  getCoinPublicKey: () => walletState.shieldedCoinPublicKey,
  getEncryptionPublicKey: () => walletState.shieldedEncryptionPublicKey,
  // ttl is ignored: mn serve applies its own TTL when balancing.
  async balanceTx(tx) {
    const result = await rpcCall('balanceUnsealedTransaction', { tx: toHex(tx.serialize()) });
    return fromHex(result.tx);
  },
});

const midnightProvider = createLedger9MidnightProvider(async (tx) => {
  await rpcCall('submitTransaction', { tx: toHex(tx.serialize()) });
  return tx.deserialize({ v9: Transaction }).identifiers()[0];
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

// The contract's initial private state, seeded with the secret mn gives the
// script in its environment (resolvePrivateStateSecretKey, injected above via
// .toString()): the paying wallet's own, derived from its seed, so every deploy
// and call of one wallet uses the same; or the caller's --secret-key.
${parts.privateStateSecretFn}
function makeInitialPrivateState() {
  if (createPrivateState) {
    const secretKey = resolvePrivateStateSecretKey(
      process.env.${parts.privateStateSecretEnv},
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

/** How long a transaction a script builds stays valid: midnight-js's own default, one hour. */
const TX_TTL_SECONDS = 3600;

/**
 * The `providers` object deploy/call pass to midnight-js-contracts. Its level
 * providers wait while another process holds the store (waitForPrivateState),
 * for the contract at `contractAddress` (undefined for a deploy).
 */
export function providerSetupCode(networkConfig: NetworkConfig, privateStateKey: string, parts: ScriptParts, contractAddress?: string): string {
  return `
const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

// The private-state store, in the folder mn names under its state root (one
// per contract), opened for the paying wallet first: kept to its owner, its
// entries under the wallet's own password and account (openPrivateStateStore).
const PRIVATE_STATE_DIR = process.env.${parts.privateStateDirEnv};
if (typeof PRIVATE_STATE_DIR !== 'string' || PRIVATE_STATE_DIR === '') {
  throw new Error('The contract script was given no private-state folder (${parts.privateStateDirEnv}): it is started by mn contract deploy or call, which name it.');
}
${parts.privateStateStoreFn}
${parts.privateStateWaitFn}
// Each private-state operation waits while another process holds the store,
// saying so as mn's notice (marked) and its progress, with the time waited.
const privateStateWait = {
  fs: mnFs,
  join: mnPath.join,
  isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notice: (line) => process.stderr.write('\\n${parts.noticeMarker} ' + JSON.stringify(line) + '\\n'),
  progress: (line) => process.stderr.write(line + '\\n'),
};
const privateStateWaitOptions = { dir: PRIVATE_STATE_DIR, address: ${JSON.stringify(contractAddress)}, ownPid: process.ppid, timeoutMs: ${parts.privateStateBusyWaitMs} };
const waitingLevelPrivateStateProvider = (config) => waitForPrivateState(levelPrivateStateProvider(config), privateStateWait, privateStateWaitOptions);
const { accountId: privateStateAccount } = await openPrivateStateStore(
  { fs: mnFs, join: mnPath.join, provide: (value) => () => value, umask: (mask) => process.umask(mask), levelPrivateStateProvider: waitingLevelPrivateStateProvider },
  {
    dir: PRIVATE_STATE_DIR,
    storeName: ${JSON.stringify(privateStateKey)},
    password: process.env.${parts.privateStatePasswordEnv},
    accountId: process.env.${parts.privateStateAccountEnv},
  },
);

const providers = {
  // The network the transactions are built for, and how long one stays valid
  // (mn serve applies its own TTL when it balances).
  config: { networkId: ${JSON.stringify(networkConfig.networkId.toLowerCase())}, ttlSeconds: ${TX_TTL_SECONDS} },
  privateStateProvider: waitingLevelPrivateStateProvider({
    midnightDbName: PRIVATE_STATE_DIR,
    privateStateStoreName: ${JSON.stringify(privateStateKey)},
    privateStoragePasswordProvider: () => process.env.${parts.privateStatePasswordEnv},
    accountId: privateStateAccount,
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
${parts.rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir, parts)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});
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

// The deploy's transaction, as the indexer listed it once midnight-js saw it final.
const deployTx = deployed.deployTxData?.public;
console.log(JSON.stringify({ contractAddress: address, txHash: deployTx?.txHash, txId: deployTx?.txId }));
rpcClose();
process.exit(0);
`;
}

export function generateCallScript(opts: CallScript, parts: ScriptParts): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;

  return `${parts.prelude}
${parts.rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir, parts)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});
process.stderr.write('Connected\\n');

${PROVIDER_IMPORTS}
${walletProviderCode()}
${providerSetupCode(opts.networkConfig, privateStateKey, parts, opts.contractAddress)}

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
const called = await deployed.callTx.${opts.circuit}(...args);

// The call's transaction, as the indexer listed it once midnight-js saw it final.
const callTx = called?.public;
console.log(JSON.stringify({ status: 'success', circuit: ${JSON.stringify(opts.circuit)}, txHash: callTx?.txHash, txId: callTx?.txId }));
rpcClose();
process.exit(0);
`;
}

export function generateStateScript(opts: StateScript, parts: ScriptParts): string {
  return `${parts.prelude}
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { ContractState } from '@midnight-ntwrk/compact-runtime';

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

const read = await provider.queryContractState(${JSON.stringify(opts.contractAddress)});
if (!read) {
  fail(new Error('No contract found at address ${opts.contractAddress}'));
}

process.stderr.write('Parsing ledger state...\\n');
// The state comes as the bytes the ledger wrote; the compact runtime the
// contract was compiled for decodes it, and ledger() reads its data (ChargedState).
const state = contractMod.ledger(read.contractState.deserialize({ v9: ContractState }).data);

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

