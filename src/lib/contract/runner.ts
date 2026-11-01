// Contract runner — execute contract operations in the dApp's own process context.
// Uses mn's serve RPC server for wallet operations (balance, sign, submit).
// The generated script only needs contract SDK + RPC client — no wallet SDK.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync, symlinkSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertEndpointUsable } from '../blockfrost.ts';
import type { NetworkConfig } from '../network.ts';
import { WITNESS_FILE_CANDIDATES } from './witness-discovery.ts';
import { coerceArg } from './arg-coerce.ts';
import { resolvePrivateStateSecretKey } from './private-state-secret.ts';
import { CancelledError, throwIfCancelled } from '../errors.ts';

// The generated deploy/call script imports SDK packages by bare specifier
// (`@midnight-ntwrk/midnight-js-contracts`, `ws`, etc.); without help, Node
// resolves those against the user's project, which usually doesn't have them.
// NODE_PATH is honored only by CommonJS resolution, not ESM, so each package
// the script needs is linked by name into the dApp's node_modules instead, and
// Node's normal walk-up from the script finds it there.

/**
 * Every package a generated script imports, and the compact runtime the
 * user's compiled contract imports. Each is found by name from mn's own
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

export interface RunnerOptions {
  dappDir: string;
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
  servePort: number;
  onMessage?: (msg: string) => void;
  /** Cancels the run: the script's process is stopped. */
  signal?: AbortSignal;
}

export interface DeployOptions extends RunnerOptions {
  privateStateKey?: string;
  /**
   * 32-byte hex secret seeded into the contract's initial private state (for a
   * contract whose constructor reads its owner from a witness). Passed to the
   * deploy subprocess via env (MN_PRIVATE_STATE_SECRET), never argv or the
   * on-disk script, so the private key is not written to disk.
   */
  privateStateSecretKey?: string;
  /**
   * Constructor arguments passed to the contract's `Constructor` (the WASM
   * function the SDK invokes during `deployContract`). Forwarded to
   * `deployContract({ args: [...] })`. Order matters — match the contract's
   * Compact `constructor(...)` signature.
   */
  args?: unknown[];
}

export interface CallOptions extends RunnerOptions {
  contractAddress: string;
  circuit: string;
  args?: unknown[];
  privateStateKey?: string;
}

export interface StateOptions {
  dappDir: string;
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
  contractAddress: string;
  onMessage?: (msg: string) => void;
  /** Cancels the run: the script's process is stopped. */
  signal?: AbortSignal;
}

export interface DeployResult {
  contractAddress: string;
}

export interface CallResult {
  status: string;
  circuit: string;
}

export interface StateResult {
  fields: Record<string, string>;
  maps: Record<string, { size: string }>;
}

// The indexer's URLs reach a generated script through its environment, not
// its text: on a network Blockfrost serves they carry the user's project id,
// and the script is a file in the dApp's directory until the run ends.
const INDEXER_URL_ENV = 'MN_INDEXER_URL';
const INDEXER_WS_URL_ENV = 'MN_INDEXER_WS_URL';

export function indexerEnvironment(networkConfig: NetworkConfig): Record<string, string> {
  assertEndpointUsable(networkConfig.indexer);
  return {
    [INDEXER_URL_ENV]: networkConfig.indexer,
    [INDEXER_WS_URL_ENV]: networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'),
  };
}

export async function runState(options: StateOptions): Promise<StateResult> {
  const script = generateStateScript(options);
  const result = await executeScript({ dir: options.dappDir, script, onMessage: options.onMessage, env: indexerEnvironment(options.networkConfig), signal: options.signal });
  try {
    return JSON.parse(result) as StateResult;
  } catch {
    throw new Error(`State script returned unexpected output:\n${result}`);
  }
}

export async function runDeploy(options: DeployOptions): Promise<DeployResult> {
  const script = generateDeployScript(options);
  // The private-state secret goes to the subprocess via env (never the on-disk
  // script) so a caller-chosen owner is not written to the filesystem.
  const extraEnv = {
    ...indexerEnvironment(options.networkConfig),
    ...(options.privateStateSecretKey ? { MN_PRIVATE_STATE_SECRET: options.privateStateSecretKey } : {}),
  };
  const result = await executeScript({ dir: options.dappDir, script, onMessage: options.onMessage, env: extraEnv, signal: options.signal });
  try {
    return JSON.parse(result) as DeployResult;
  } catch {
    throw new Error(`Deploy script returned unexpected output:\n${result}`);
  }
}

export async function runCall(options: CallOptions): Promise<CallResult> {
  const script = generateCallScript(options);
  const result = await executeScript({ dir: options.dappDir, script, onMessage: options.onMessage, env: indexerEnvironment(options.networkConfig), signal: options.signal });
  try {
    return JSON.parse(result) as CallResult;
  } catch {
    throw new Error(`Call script returned unexpected output:\n${result}`);
  }
}

// ── Shared script fragments ──

/** Minimal JSON-RPC client over WebSocket that talks to mn serve. */
export function rpcClientCode(servePort: number, wsSpecifier: string = 'ws'): string {
  return `
import WebSocket from ${JSON.stringify(wsSpecifier)};

const RPC_URL = 'ws://127.0.0.1:${servePort}';
let rpcId = 0;
let rpcWs;

async function rpcConnect() {
  return new Promise((resolve, reject) => {
    rpcWs = new WebSocket(RPC_URL);
    rpcWs.on('open', () => resolve(rpcWs));
    rpcWs.on('error', (err) => reject(new Error('Cannot connect to mn serve at ' + RPC_URL + ': ' + err.message)));
    setTimeout(() => reject(new Error('Timeout connecting to mn serve at ' + RPC_URL)), 5000);
  });
}

function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timeout = setTimeout(() => reject(new Error('RPC timeout for ' + method)), 300000);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          rpcWs.removeListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };

    rpcWs.on('message', handler);
    rpcWs.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function rpcClose() {
  if (rpcWs) rpcWs.close();
}
`;
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

// resolvePrivateStateSecretKey serialized for the generated script (same
// .toString()-inlining trick as ARG_COERCE_FN, so makeInitialPrivateState below
// and the test suite share one implementation).
const PRIVATE_STATE_SECRET_FN = `\nconst resolvePrivateStateSecretKey = (${resolvePrivateStateSecretKey.toString()});\n`;

function contractSetupCode(contractName: string, managedDir: string): string {
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
const WITNESS_CANDIDATES = ${JSON.stringify(WITNESS_FILE_CANDIDATES)};
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
${PRIVATE_STATE_SECRET_FN}
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
export function providerSetupCode(networkConfig: NetworkConfig, privateStateKey: string): string {
  return `
const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: ${JSON.stringify(privateStateKey)},
    privateStoragePasswordProvider: () => Promise.resolve('mn-contract-default-pwd-16ch'),
    accountId: 'mn-contract-runner',
  }),
  publicDataProvider: indexerPublicDataProvider({
    queryURL: process.env.${INDEXER_URL_ENV},
    subscriptionURL: process.env.${INDEXER_WS_URL_ENV},
  }),
  zkConfigProvider,
  proofProvider: httpClientProofProvider({ url: ${JSON.stringify(networkConfig.proofServer)}, zkConfigProvider }),
  walletProvider,
  midnightProvider,
};
`;
}

// ── Script generation ──

/**
 * Inline arg-coercion helper for the generated bridge script. Compact
 * circuits use only a small set of runtime types (BigInt for Uint, Uint8Array
 * for Bytes, primitives, plus structs of these), but JSON arg payloads —
 * coming from CLI `--args` flags or MCP `args` params — can only encode
 * numbers, strings, arrays, objects, and booleans. We coerce predictably:
 *
 *   - number              → BigInt              (Uint<N> circuit args within
 *                                                Number.MAX_SAFE_INTEGER)
 *   - "123n"              → BigInt(123)         (BigInt literal syntax — for
 *                                                values bigger than what JSON
 *                                                numbers can carry safely;
 *                                                e.g. registerProvider's
 *                                                256-bit field elements)
 *   - array of 0–255 ints → Uint8Array          (Bytes<N> circuit args)
 *   - object              → recurse into values (Struct args; field types
 *                                                inferred per-value)
 *   - array (non-byte)    → recurse into items
 *
 * Plain strings, booleans, null, and Uint8Array pass through unchanged.
 *
 * Implementation lives in arg-coerce.ts so we can unit-test it directly.
 * Here it's serialized via .toString() and bound to a stable `coerceArg`
 * const in the generated bridge — bun's minifier mangles the function's
 * own name, so we can't rely on the inlined body declaring it under the
 * expected identifier. Wrapping in parens + assigning to const keeps the
 * call site (`...map(coerceArg)`) referring to the right thing regardless.
 */
const ARG_COERCE_FN = `\nconst coerceArg = (${coerceArg.toString()});\n`;

/** Marks the line a generated script reports its failure on, so mn can tell it from progress and warnings. */
export const SCRIPT_ERROR_MARKER = '__MN_ERROR__';

/**
 * First in every generated script: report any failure (a rejected top-level
 * await included) as one marked line, then exit 1. Without it Node prints the
 * uncaught exception with its source context, and that became mn's error.
 */
export const SCRIPT_PRELUDE = `
const fail = (e) => {
  process.stderr.write('\\n${SCRIPT_ERROR_MARKER} ' + JSON.stringify(String(e?.message ?? e)) + '\\n');
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
`;

/** The failure a generated script reported, or its whole stderr when it reported none. */
export function scriptFailureMessage(stderr: string, exitCode: number | null): string {
  const marked = new RegExp(`^${SCRIPT_ERROR_MARKER} (.*)$`, 'm').exec(stderr);
  if (marked) {
    try { return JSON.parse(marked[1]!) as string; } catch { return marked[1]!; }
  }
  return stderr.trim() || `Script exited with code ${exitCode}`;
}

export function generateDeployScript(opts: DeployOptions): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;
  // Constructor args are pre-serialized to JSON here (still in our process)
  // so the generated script just spreads them. The coerceArg helper inside
  // the bridge then upgrades number → BigInt and number[] → Uint8Array, the
  // two coercions Compact circuits invariably need.
  const argsLiteral = JSON.stringify(opts.args ?? []);

  return `${SCRIPT_PRELUDE}
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${PROVIDER_IMPORTS}
${walletProviderCode()}
${providerSetupCode(opts.networkConfig, privateStateKey)}

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

${ARG_COERCE_FN}
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

export function generateCallScript(opts: CallOptions): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;

  return `${SCRIPT_PRELUDE}
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${PROVIDER_IMPORTS}
${walletProviderCode()}
${providerSetupCode(opts.networkConfig, privateStateKey)}

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

process.stderr.write('Finding deployed contract...\\n');
const deployed = await findDeployedContract(providers, {
  compiledContract: compiled,
  contractAddress: ${JSON.stringify(opts.contractAddress)},
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
});

process.stderr.write('Calling ${opts.circuit}...\\n');
${ARG_COERCE_FN}
const args = (${JSON.stringify(opts.args ?? [])}).map(coerceArg);
await deployed.callTx.${opts.circuit}(...args);

console.log(JSON.stringify({ status: 'success', circuit: ${JSON.stringify(opts.circuit)} }));
rpcClose();
process.exit(0);
`;
}

export function generateStateScript(opts: StateOptions): string {
  return `${SCRIPT_PRELUDE}
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
  queryURL: process.env.${INDEXER_URL_ENV},
  subscriptionURL: process.env.${INDEXER_WS_URL_ENV},
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

// ── Script execution ──

/** What the overlay made, to undo afterwards newest first: a link, or a folder it created. */
type Made = { path: string; kind: 'link' | 'folder' };

/** The installed copy of each scope SCRIPT_PACKAGES uses (`@midnight-ntwrk`, …), and the node_modules holding them. */
function installedTrees(): { root: string | null; scopes: Map<string, string> } {
  const scopes = new Map<string, string>();
  let root: string | null = null;
  for (const name of SCRIPT_PACKAGES) {
    if (!name.startsWith('@')) continue;
    const folder = packageFolder(name);
    if (folder === null) continue;
    const scope = name.slice(0, name.indexOf('/'));
    if (!scopes.has(scope)) scopes.set(scope, dirname(folder));
    root ??= dirname(dirname(folder));
  }
  return { root, scopes };
}

/**
 * Make SCRIPT_PACKAGES, and whatever else a dApp's witnesses import from the
 * same installed tree, resolvable from `userNodeModules`, finding mn's copy
 * by name (never by walking up from this file):
 *   - a dApp with no node_modules gets a link to the node_modules holding them;
 *   - a dApp without one of their scopes gets a link to that whole scope;
 *   - a package still missing (in a scope the dApp has, or unscoped) is linked
 *     on its own.
 * Never replaces what the dApp has: the user may pin a version we shouldn't
 * shadow. What can't be found or linked is left out, and the script then fails
 * with Node's clear ERR_MODULE_NOT_FOUND.
 */
export function overlayScriptPackages(userNodeModules: string): Made[] {
  const made: Made[] = [];
  const link = (target: string, at: string): void => {
    try {
      symlinkSync(target, at, 'dir');
      made.push({ path: at, kind: 'link' });
    } catch { /* left out: the script reports the missing package */ }
  };
  const { root, scopes } = installedTrees();
  if (!existsSync(userNodeModules)) {
    if (root !== null) link(root, userNodeModules);
    return made;
  }
  for (const [scope, folder] of scopes) {
    const at = join(userNodeModules, scope);
    if (!existsSync(at)) link(folder, at);
  }
  for (const name of SCRIPT_PACKAGES) {
    const at = join(userNodeModules, name);
    const target = existsSync(at) ? null : packageFolder(name);
    if (target !== null) link(target, at);
  }
  return made;
}

/** Removes what overlayScriptPackages made, newest first; a folder only if it is empty again. */
export function undoOverlay(made: readonly Made[]): void {
  for (const item of made.slice().reverse()) {
    try {
      if (item.kind === 'link') unlinkSync(item.path);
      else rmdirSync(item.path);
    } catch { /* best-effort: never touch what the dApp has */ }
  }
}

/** The record, in a dApp folder, of the overlay its running scripts share. */
const OVERLAY_RECORD = '.mn-overlay.json';
interface OverlayRecord { pids: number[]; made: Made[] }

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Takes a share of the dApp's overlay for this run, making it if no live run
 * holds one. Runs in one folder at once share it, so one finishing never
 * removes links another still uses; a run that died leaves its pid, which the
 * next run drops.
 */
export function acquireOverlay(dappDir: string): void {
  const record = join(dappDir, OVERLAY_RECORD);
  let held: OverlayRecord | null = null;
  try { held = JSON.parse(readFileSync(record, 'utf8')) as OverlayRecord; } catch { /* none yet */ }
  const live = (held?.pids ?? []).filter(isAlive);
  const made = held !== null ? held.made : overlayScriptPackages(join(dappDir, 'node_modules'));
  writeFileSync(record, JSON.stringify({ pids: [...live, process.pid], made } satisfies OverlayRecord));
}

/** Gives back this run's share; the last run out undoes the overlay and removes the record. */
export function releaseOverlay(dappDir: string): void {
  const record = join(dappDir, OVERLAY_RECORD);
  let held: OverlayRecord;
  try { held = JSON.parse(readFileSync(record, 'utf8')) as OverlayRecord; } catch { return; }
  const mine = held.pids.indexOf(process.pid);
  const pids = held.pids.filter((pid, at) => at !== mine && isAlive(pid));
  if (pids.length > 0) {
    writeFileSync(record, JSON.stringify({ pids, made: held.made } satisfies OverlayRecord));
    return;
  }
  undoOverlay(held.made);
  try { unlinkSync(record); } catch { /* already gone */ }
}

/** A generated script to run with node, and where. */
export interface ScriptRun {
  /** Where the script file is written: its bare imports resolve from here. */
  dir: string;
  script: string;
  /** Each line the script writes to stderr, other than its marked error. */
  onMessage?: (msg: string) => void;
  /** Set over mn's own environment; a variable given as undefined is cleared. */
  env?: Record<string, string | undefined>;
  /** The script's working directory; `dir` when not given. */
  cwd?: string;
  /** Make mn's own SDK packages resolvable from `dir` when it lacks them. Default true. */
  overlaySdk?: boolean;
  /** What the script is for: part of its (hidden, removed afterwards) file name. Default "contract". */
  label?: string;
  /** Stops the run when it aborts: the script's process is killed, and the run fails as cancelled. */
  signal?: AbortSignal;
  /** Finds the Node.js to run the script with; scriptRuntime unless given. */
  findRuntime?: () => string;
}

// How long a cancelled script has to exit on SIGTERM before it is killed outright.
const CANCEL_GRACE_MS = 5_000;
/** Random bytes in a generated script's name, beside the time. */
const SCRIPT_NAME_RANDOM_BYTES = 4;

/** No Node.js to run a generated script with: mn runs under another runtime and none is on PATH. */
export class NoNodeRuntimeError extends Error {
  readonly code = 'NO_NODE_RUNTIME';
  constructor() {
    super('Contract scripts run under Node.js, and none was found on PATH. Install Node.js 22 or later, or run mn under Node.');
    this.name = 'NoNodeRuntimeError';
    Object.setPrototypeOf(this, NoNodeRuntimeError.prototype);
  }
}

/**
 * The Node.js a generated script runs with: the one running mn, which passed
 * its version checks; or, when mn runs under another runtime (bun), the first
 * `node` on `searchPath`.
 */
export function scriptRuntime(
  runtime: { execPath: string; isNode: boolean } = { execPath: process.execPath, isNode: process.versions.bun === undefined },
  searchPath: string = process.env.PATH ?? '',
): string {
  if (runtime.isNode) return runtime.execPath;
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of searchPath.split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  throw new NoNodeRuntimeError();
}

/** Runs a generated script and returns what it wrote to stdout. Throws its marked error when it fails. */
export async function executeScript({ dir: dappDir, script, onMessage, env: extraEnv, cwd, overlaySdk = true, label = 'contract', signal, findRuntime = scriptRuntime }: ScriptRun): Promise<string> {
  throwIfCancelled(signal);
  // ESM resolution walks up from the importing file's location to find
  // node_modules; NODE_PATH does NOT work for ESM. Three different files
  // need to resolve bare imports during a deploy:
  //   1. the generated script.mjs (in dappDir)
  //   2. the user's compiled contract/index.js (under managed/<name>/)
  //   3. the user's witnesses.js (under dist/ or src/)
  // All three live somewhere under dappDir, so symlinking ours into the
  // dApp's node_modules satisfies all of them (overlayScriptPackages); the
  // last run out removes only what was made, so the dApp ends as we found it.
  // Resolved before anything is written, so a missing Node leaves the dApp as it was.
  const runtime = findRuntime();
  // Unique to this run, so two at once in one directory never share a script.
  const scriptPath = join(dappDir, `.mn-${label}-${Date.now()}-${randomBytes(SCRIPT_NAME_RANDOM_BYTES).toString('hex')}.mjs`);
  if (overlaySdk) acquireOverlay(dappDir);
  const cleanup = () => {
    try { unlinkSync(scriptPath); } catch {}
    // Our share of the overlay goes back; the last run out undoes it (links
    // go, never their targets; a folder we made goes only once empty).
    if (overlaySdk) releaseOverlay(dappDir);
  };
  try {
    writeFileSync(scriptPath, script);
  } catch (err) {
    cleanup();
    throw err;
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(runtime, [scriptPath], {
      cwd: cwd ?? dappDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        ...extraEnv,
      },
    });

    let stdout = '';
    // Untrimmed, so a marked error line split across two pipe reads stays whole.
    let stderrRaw = '';

    let killTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), CANCEL_GRACE_MS);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const settle = () => {
      signal?.removeEventListener('abort', cancel);
      clearTimeout(killTimer);
      cleanup();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrRaw += chunk.toString();
      const line = chunk.toString().trim();
      if (line && !line.includes(SCRIPT_ERROR_MARKER)) onMessage?.(line);
    });

    child.on('close', (code) => {
      settle();
      if (signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      if (code !== 0) {
        reject(new Error(scriptFailureMessage(stderrRaw, code)));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      settle();
      reject(err);
    });
  });
}
