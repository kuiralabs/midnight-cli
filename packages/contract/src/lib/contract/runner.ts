// Contract runner — execute contract operations in the dApp's own process context.
// Uses mn's serve RPC server for wallet operations (balance, sign, submit).
// The generated script only needs contract SDK + RPC client — no wallet SDK.
// The engine for the network's SDK set writes the script and names the
// packages it imports; the runner adds what every set's script shares, makes
// those packages resolvable from the dApp, and runs it.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync, symlinkSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertEndpointUsable, type NetworkConfig, type NetworkName, sdkSetOf, type EngineContractScripts, type HostEngines, type ScriptParts, CancelledError, throwIfCancelled, isTransportFailure } from '@kuiralabs/midnight-cli-core';
import { findContractInfo } from './inspect.ts';
import { assertContractRunsOn } from './runtime-check.ts';
import { WITNESS_FILE_CANDIDATES } from './witness-discovery.ts';
import { coerceArg } from './arg-coerce.ts';
import { resolvePrivateStateSecretKey } from './private-state-secret.ts';

// The generated deploy/call script imports SDK packages by bare specifier
// (`@midnight-ntwrk/midnight-js-contracts`, `ws`, etc.); without help, Node
// resolves those against the user's project, which usually doesn't have them.
// NODE_PATH is honored only by CommonJS resolution, not ESM, so each package
// the script needs is linked by name into the dApp's node_modules instead, and
// Node's normal walk-up from the script finds it there.


export interface RunnerOptions {
  dappDir: string;
  /** The network: its engine writes the script. */
  network: NetworkName;
  /** The state root whose config names the network's SDK set. */
  root: string;
  /** The engines of the host the run is in: the network's engine writes the script. */
  engines: HostEngines;
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
  /** The network: its engine writes the script. */
  network: NetworkName;
  /** The state root whose config names the network's SDK set. */
  root: string;
  /** The engines of the host the run is in: the network's engine writes the script. */
  engines: HostEngines;
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
  // Every run, whoever starts it (dev, test, a program): the contract must suit the network's engine.
  throwIfCancelled(options.signal);
  await assertContractRunsOn(findContractInfo(options.managedDir).info, options.network, options.root, options.engines);
  const engine = await options.engines.load(sdkSetOf(options.network, options.root));
  const scripts = { ...engine.contracts.scripts, set: engine.set };
  const script = scripts.state(options, SCRIPT_PARTS);
  const result = await executeScript({ dir: options.dappDir, script, packages: scripts, onMessage: options.onMessage, env: indexerEnvironment(options.networkConfig), signal: options.signal });
  try {
    return JSON.parse(result) as StateResult;
  } catch {
    throw new Error(`State script returned unexpected output:\n${result}`);
  }
}

export async function runDeploy(options: DeployOptions): Promise<DeployResult> {
  // Every run, whoever starts it (dev, test, a program): the contract must suit the network's engine.
  throwIfCancelled(options.signal);
  await assertContractRunsOn(findContractInfo(options.managedDir).info, options.network, options.root, options.engines);
  const engine = await options.engines.load(sdkSetOf(options.network, options.root));
  const scripts = { ...engine.contracts.scripts, set: engine.set };
  const script = scripts.deploy(options, SCRIPT_PARTS);
  // The private-state secret goes to the subprocess via env (never the on-disk
  // script) so a caller-chosen owner is not written to the filesystem.
  const extraEnv = {
    ...indexerEnvironment(options.networkConfig),
    ...(options.privateStateSecretKey ? { MN_PRIVATE_STATE_SECRET: options.privateStateSecretKey } : {}),
  };
  const result = await executeScript({ dir: options.dappDir, script, packages: scripts, onMessage: options.onMessage, env: extraEnv, signal: options.signal });
  try {
    return JSON.parse(result) as DeployResult;
  } catch {
    throw new Error(`Deploy script returned unexpected output:\n${result}`);
  }
}

export async function runCall(options: CallOptions): Promise<CallResult> {
  // Every run, whoever starts it (dev, test, a program): the contract must suit the network's engine.
  throwIfCancelled(options.signal);
  await assertContractRunsOn(findContractInfo(options.managedDir).info, options.network, options.root, options.engines);
  const engine = await options.engines.load(sdkSetOf(options.network, options.root));
  const scripts = { ...engine.contracts.scripts, set: engine.set };
  const script = scripts.call(options, SCRIPT_PARTS);
  const result = await executeScript({ dir: options.dappDir, script, packages: scripts, onMessage: options.onMessage, env: indexerEnvironment(options.networkConfig), signal: options.signal });
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
    rpcWs.on('error', (err) => reject(new Error('Cannot connect to mn serve at ' + RPC_URL + ': ' + err.message, { cause: err })));
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
          // mn serve's failure, with mn's code for it when the server gave one,
          // kept as the last refusal for the prelude's fail (see SCRIPT_PRELUDE).
          if (msg.error) reject(globalThis.mnServeRefusal = Object.assign(new Error(msg.error.message || JSON.stringify(msg.error)), typeof msg.error.data?.mnCode === 'string' ? { code: msg.error.data.mnCode } : {}));
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

// resolvePrivateStateSecretKey serialized for the generated script (the same
// .toString()-inlining trick as ARG_COERCE_FN, so the script's
// makeInitialPrivateState and the test suite share one implementation).
const PRIVATE_STATE_SECRET_FN = `\nconst resolvePrivateStateSecretKey = (${resolvePrivateStateSecretKey.toString()});\n`;

/** Marks the line a generated script reports its failure on, so mn can tell it from progress and warnings. */
export const SCRIPT_ERROR_MARKER = '__MN_ERROR__';

// isTransportFailure serialized for the generated script (the same
// .toString()-inlining trick as ARG_COERCE_FN): the script names a connection
// it could not make (to mn serve, the indexer, the proof server) itself.
const TRANSPORT_FAILURE_FN = `\nconst isTransportFailure = (${isTransportFailure.toString()});\n`;

/**
 * First in every generated script: report any failure (a rejected top-level
 * await included) as one marked line, its message and its code, then exit 1:
 * the code it carries (mn serve's code for a failure there), or NETWORK_ERROR
 * for a connection that could not be made, which carries only the socket's
 * (ECONNREFUSED) or none. Without it Node prints the uncaught exception with
 * its source context, and that became mn's error.
 *
 * midnight-js 5 reports a provider's failure as its own ProviderFailedError,
 * rebuilding the provider's error on `cause` with its message and nothing
 * else, so mn serve's code is lost there. The script's client for mn serve
 * keeps the last refusal it received (rpcClientCode), and a failure of the
 * providers backed by mn serve is reported as that refusal.
 */
export const SCRIPT_PRELUDE = `${TRANSPORT_FAILURE_FN}
const SERVE_BACKED_PROVIDER_METHODS = ['balanceTx', 'submitTx'];
const fail = (e) => {
  const refusal = globalThis.mnServeRefusal;
  if (e?.name === 'ProviderFailedError' && SERVE_BACKED_PROVIDER_METHODS.includes(e.method) && refusal) e = refusal;
  const carried = typeof e?.code === 'string' && !isTransportFailure({ code: e.code }) ? e.code : undefined;
  const code = carried ?? (isTransportFailure(e) ? 'NETWORK_ERROR' : undefined);
  const failure = { message: String(e?.message ?? e), ...(code === undefined ? {} : { code }) };
  process.stderr.write('\\n${SCRIPT_ERROR_MARKER} ' + JSON.stringify(failure) + '\\n');
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
`;

/** What a generated script reported failing with: its message, and the code the failure carried. */
export interface ScriptFailure {
  message: string;
  code?: string;
}

/** The failure a generated script reported (a script of an older mn reported its message alone), or its whole stderr when it reported none. */
export function scriptFailureOf(stderr: string, exitCode: number | null): ScriptFailure {
  const marked = new RegExp(`^${SCRIPT_ERROR_MARKER} (.*)$`, 'm').exec(stderr);
  if (marked) {
    let reported: unknown;
    try { reported = JSON.parse(marked[1]!); } catch { return { message: marked[1]! }; }
    if (typeof reported === 'string') return { message: reported };
    const { message, code } = (reported ?? {}) as { message?: unknown; code?: unknown };
    return { message: typeof message === 'string' ? message : marked[1]!, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { message: stderr.trim() || `Script exited with code ${exitCode}` };
}

/** The message of the failure a generated script reported, or its whole stderr when it reported none. */
export function scriptFailureMessage(stderr: string, exitCode: number | null): string {
  return scriptFailureOf(stderr, exitCode).message;
}

/** A generated script failed: its message, and the code its failure carried across the process (undefined when it carried none). */
export class ContractScriptError extends Error {
  readonly code: string | undefined;

  constructor({ message, code }: ScriptFailure) {
    super(message);
    this.code = code;
    this.name = 'ContractScriptError';
    Object.setPrototypeOf(this, ContractScriptError.prototype);
  }
}

/** What every SDK set's script shares, for the engine to write it with. */
export const SCRIPT_PARTS: ScriptParts = {
  prelude: SCRIPT_PRELUDE,
  rpcClientCode,
  coerceArgFn: ARG_COERCE_FN,
  privateStateSecretFn: PRIVATE_STATE_SECRET_FN,
  witnessCandidates: WITNESS_FILE_CANDIDATES,
  indexerUrlEnv: INDEXER_URL_ENV,
  indexerWsUrlEnv: INDEXER_WS_URL_ENV,
};

// ── Script execution ──

/** What the overlay made, to undo afterwards newest first: a link, or a folder it created. */
type Made = { path: string; kind: 'link' | 'folder' };

/** The packages a script imports, where the engine's install has each, and the SDK set they are. */
type ScriptPackages = Pick<EngineContractScripts, 'packages' | 'packageFolder'> & { readonly set: string };

/**
 * The installed copy of each scope the script packages use (`@midnight-ntwrk`,
 * …), and the node_modules holding them: each only when it holds every script
 * package of its kind. An install can hoist some of an engine's packages away
 * from the rest (a workspace puts a package both engines share at its root),
 * and a tree linked whole must then not stand in for the packages it lacks.
 */
function installedTrees({ packages, packageFolder }: ScriptPackages): { root: string | null; scopes: Map<string, string> } {
  const folders = new Map<string, string>();
  for (const name of packages) {
    const folder = packageFolder(name);
    if (folder !== null) folders.set(name, folder);
  }
  const scopeOf = (name: string): string => name.slice(0, name.indexOf('/'));
  const holderOf = (name: string): string | undefined => {
    const folder = folders.get(name);
    if (folder === undefined) return undefined;
    return name.startsWith('@') ? dirname(dirname(folder)) : dirname(folder);
  };
  const holders = new Set(packages.map(holderOf));
  const root = holders.size === 1 ? [...holders][0] ?? null : null;
  const scopes = new Map<string, string>();
  for (const scope of new Set(packages.filter((name) => name.startsWith('@')).map(scopeOf))) {
    const inScope = new Set(packages.filter((name) => name.startsWith(scope + '/')).map((name) => {
      const folder = folders.get(name);
      return folder === undefined ? undefined : dirname(folder);
    }));
    const only = inScope.size === 1 ? [...inScope][0] : undefined;
    if (only !== undefined) scopes.set(scope, only);
  }
  return { root, scopes };
}

/**
 * Make the script packages, and whatever else a dApp's witnesses import from
 * the same installed tree, resolvable from `userNodeModules`, finding the
 * engine's copy by name (never by walking up from this file):
 *   - a dApp with no node_modules gets a link to the node_modules holding them
 *     all, or else a folder of its own for the links below;
 *   - a dApp without one of their scopes gets a link to that whole scope, when
 *     one folder holds all of the scope's script packages;
 *   - a package still missing (in a scope the dApp has, or unscoped) is linked
 *     on its own.
 * Never replaces what the dApp has: the user may pin a version we shouldn't
 * shadow. What can't be found or linked is left out, and the script then fails
 * with Node's clear ERR_MODULE_NOT_FOUND.
 */
export function overlayScriptPackages(userNodeModules: string, scriptPackages: ScriptPackages): Made[] {
  const made: Made[] = [];
  const link = (target: string, at: string): void => {
    try {
      symlinkSync(target, at, 'dir');
      made.push({ path: at, kind: 'link' });
    } catch { /* left out: the script reports the missing package */ }
  };
  const folder = (at: string): boolean => {
    if (existsSync(at)) return true;
    try {
      mkdirSync(at);
      made.push({ path: at, kind: 'folder' });
      return true;
    } catch {
      return false;
    }
  };
  const { root, scopes } = installedTrees(scriptPackages);
  if (!existsSync(userNodeModules)) {
    if (root !== null) {
      link(root, userNodeModules);
      return made;
    }
    if (!folder(userNodeModules)) return made;
  }
  // A scope linked whole is the engine's own folder: nothing is linked inside
  // it, which would write into the engine's install.
  const linkedWhole = new Set<string>();
  for (const [scope, scopeFolder] of scopes) {
    const at = join(userNodeModules, scope);
    if (!existsSync(at)) {
      link(scopeFolder, at);
      linkedWhole.add(scope);
    }
  }
  for (const name of scriptPackages.packages) {
    const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : null;
    if (scope !== null && linkedWhole.has(scope)) continue;
    const at = join(userNodeModules, name);
    if (existsSync(at)) continue;
    const target = scriptPackages.packageFolder(name);
    if (target === null) continue;
    if (scope !== null && !folder(join(userNodeModules, scope))) continue;
    link(target, at);
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
interface OverlayRecord { pids: number[]; made: Made[]; set?: string }

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Takes a share of the dApp's overlay for this run, making it if no live run
 * holds one. Runs in one folder at once share it, so one finishing never
 * removes links another still uses; a run that died leaves its pid, which the
 * next run drops.
 */
export function acquireOverlay(dappDir: string, scriptPackages: ScriptPackages): void {
  const record = join(dappDir, OVERLAY_RECORD);
  let held: OverlayRecord | null = null;
  try { held = JSON.parse(readFileSync(record, 'utf8')) as OverlayRecord; } catch { /* none yet */ }
  const live = (held?.pids ?? []).filter(isAlive);
  // An overlay of another SDK set's packages: refused while a run uses it,
  // undone once none does (an older mn recorded no set: its packages are the rc set's).
  if (held !== null && (held.set ?? 'rc') !== scriptPackages.set) {
    if (live.length > 0) {
      throw new Error(`Another contract run in ${dappDir} uses the ${held.set ?? 'rc'} SDK set's packages, and this one needs the ${scriptPackages.set} set's. Run it when that one has finished.`);
    }
    undoOverlay(held.made);
    held = null;
  }
  const made = held !== null ? held.made : overlayScriptPackages(join(dappDir, 'node_modules'), scriptPackages);
  writeFileSync(record, JSON.stringify({ pids: [...live, process.pid], made, set: scriptPackages.set } satisfies OverlayRecord));
}

/** Gives back this run's share; the last run out undoes the overlay and removes the record. */
export function releaseOverlay(dappDir: string): void {
  const record = join(dappDir, OVERLAY_RECORD);
  let held: OverlayRecord;
  try { held = JSON.parse(readFileSync(record, 'utf8')) as OverlayRecord; } catch { return; }
  const mine = held.pids.indexOf(process.pid);
  const pids = held.pids.filter((pid, at) => at !== mine && isAlive(pid));
  if (pids.length > 0) {
    writeFileSync(record, JSON.stringify({ pids, made: held.made, ...(held.set === undefined ? {} : { set: held.set }) } satisfies OverlayRecord));
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
  /** The packages the script imports, and where the engine's install has each: what the overlay links. */
  packages: ScriptPackages;
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
export async function executeScript({ dir: dappDir, script, packages, onMessage, env: extraEnv, cwd, overlaySdk = true, label = 'contract', signal, findRuntime = scriptRuntime }: ScriptRun): Promise<string> {
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
  if (overlaySdk) acquireOverlay(dappDir, packages);
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
        reject(new ContractScriptError(scriptFailureOf(stderrRaw, code)));
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
