// What `mn grant` gives the account package (@kuiralabs/midnight-account-chain),
// which it calls in its own process through the engine of the network's SDK
// set: the network it acts on, where the proving keys are cached, its
// progress, and the account's records, device key and private state, all in
// the account's records directory.
//
// The records are where every account so far keeps them, so an account made by
// an earlier mn opens unchanged: owner.json (the account's records and its
// owner key) and roster.json, with the private state in the directory's
// midnight-level-db under the store name and password it was first made with.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountContext, ProgressEvent } from '@kuiralabs/midnight-account-chain/context';
import type { DirectoryDeviceKeys, OwnerDevice, OwnerStore, PrivateStateLocation } from '@kuiralabs/midnight-account-chain/owner';
import { PRIVATE_STATE_DATABASE } from '@kuiralabs/midnight-contract';
import { type PassphraseSource, passphraseForNewSecret, unlockPassphrase, type UnlockHost } from '@kuiralabs/midnight-wallet';
import {
  AccountMigrationInterruptedError,
  type SealedDeviceKeys,
  createAccountKey,
  isAccountMigrating,
  isSealedAccount,
  openAccountKey,
  ownDeviceCode,
  sealedDeviceKeys,
  sealedDeviceReadSecret,
  sealedOwnerStore,
  sealedPrivateStatePassword,
} from './sealed-account.ts';
import type { NetworkConfig, NetworkName } from '@kuiralabs/midnight-cli-core';
import { type AccountChain, accountChainOf } from './account-chain.ts';
import { AccountKeysUnavailableError, MIN_NODE_FOR_ACCOUNT, NodeTooOldForAccountError, UnreachableByAccountError } from './account-errors.ts';
import { accountArtifactsDir } from './account-records.ts';

/**
 * The networks the account package acts on, by the network id midnight-js
 * keeps (mn's own, lower-cased): ledger 9's, a local network on the release
 * candidates' set and stagenet on its beta set.
 */
const ACCOUNT_NETWORKS: readonly NetworkName[] = ['undeployed', 'stagenet'];

/** The private state's database, store and password, as every account so far was made with them. */
const PRIVATE_STATE_STORE = 'midnight-bench-account';
// The password the account package encrypted every account's private state
// with until it took one from its caller: testkit-js's own, public in its
// source. It protects nothing a reader of this machine's files couldn't read.
// It stays only so a plain-text account an earlier mn made is read until
// `midnight wallet protect` re-encrypts its private state under a password of
// its own; a sealed account never uses it.
export const LEGACY_STORE_PASSWORD = 'Answer to the Ultimate Question of Life, the Universe, and Everything!';

/** Where an account's private state is kept in its records directory, under `password`. */
export function privateStateLocationOf(recordsDir: string, password: () => string): PrivateStateLocation {
  return { database: join(recordsDir, PRIVATE_STATE_DATABASE), store: PRIVATE_STATE_STORE, password };
}

/** The network the account package acts on for `networkConfig`; throws when it can't act on it. */
export function assertAccountNetwork(networkConfig: NetworkConfig): NetworkName {
  const network = ACCOUNT_NETWORKS.find((name) => name === networkConfig.networkId.toLowerCase());
  if (network === undefined) throw new UnreachableByAccountError(networkConfig.networkId);
  return network;
}

/** Throws when this Node.js is older than the account package needs. */
export function assertNodeRunsAccount(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_NODE_FOR_ACCOUNT.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new NodeTooOldForAccountError(version);
}

/** The compiler version of the account build `chain` runs, from its contract-info.json; undefined when it can't be read. */
function accountCompilerVersion(chain: AccountChain): string | undefined {
  try {
    const info = JSON.parse(readFileSync(join(chain.contract.ACCOUNT_BUILD, 'compiler', 'contract-info.json'), 'utf8')) as { 'compiler-version'?: unknown };
    return typeof info['compiler-version'] === 'string' ? info['compiler-version'] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A failure to get one of the account contract's proving keys, among `err`
 * and its causes (the account package's ArtefactFetchError, as midnight-js
 * wraps it: "Failed to read verifier key for Account#…"), as an
 * AccountKeysUnavailableError naming the key and the build; undefined for any
 * other failure. Keys the build's release doesn't have (HTTP 404) are said to
 * be unpublished, which retrying can't change.
 */
export function accountKeysFailureOf(err: unknown, chain: AccountChain): AccountKeysUnavailableError | undefined {
  const seen = new Set<unknown>();
  let fetch: Error | undefined;
  for (let current: unknown = err; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current instanceof chain.errors.ArtefactFetchError) { fetch = current; break; }
  }
  if (fetch === undefined) return undefined;
  const file = /proving artefact (\S+) from /.exec(fetch.message)?.[1] ?? 'a proving key';
  const compiler = accountCompilerVersion(chain);
  const build = `account build ${chain.artefacts.ACCOUNT_BUILD_ID}${compiler === undefined ? '' : ` (compiled with compactc ${compiler})`}`;
  const unpublished = fetch.cause instanceof Error && /\bHTTP 404\b/.test(fetch.cause.message);
  return new AccountKeysUnavailableError(file, unpublished
    ? `The account contract's ${file} isn't available: the keys of this ${build} are not published (${chain.artefacts.BUILD_RELEASE} answered HTTP 404). `
      + 'mn grant needs them to deploy and to act on an account, and retrying won\'t help: use an mn release whose account build has its keys published.'
    : `The account contract's ${file} for this ${build} could not be had: ${fetch.message}`);
}

/** The node's http(s) form: mn keeps it as the WebSocket URL its wallet connects to. */
const httpOf = (url: string): string => url.replace(/^ws/, 'http');

/** How an account's records are kept: sealed under mn's passphrase, or in plain text as an earlier mn wrote them. */
export type AccountProtection = 'sealed' | 'plain-text';

/** Everything the account package needs to act on one wallet's account. */
export interface GrantAccount {
  /** The account package, as the engine of the network's SDK set installs it. */
  chain: AccountChain;
  context: AccountContext;
  store: OwnerStore;
  keys: DirectoryDeviceKeys | SealedDeviceKeys;
  location: PrivateStateLocation;
  protection: AccountProtection;
  /** The owner device's read key, for the owner-device mailbox: a sealed account's only. */
  deviceReadSecret?: () => Uint8Array;
  /** This machine's device code: a sealed account's only. */
  ownCode?: () => string;
}

/** Where an account's passphrase comes from, and where a warning about a plain-text account goes (the host's notices, unless given). */
export interface OpenAccountOptions {
  /** The state root holding mn's passphrase check and the proving artefacts. */
  root: string;
  /** The host: who is asked for the passphrase, the passphrase it has unlocked, its notices, and its engines (the network's installs the account package, and its policy is the one the private-state password meets). */
  host: UnlockHost;
  source?: PassphraseSource;
  warn?: (line: string) => void;
}

/**
 * The account in `recordsDir` on `networkConfig`'s network, its progress said
 * through `say`: a sealed account opened with mn's passphrase; an account an
 * earlier mn wrote in plain text, as it was, with a warning; or, with nothing
 * on record (a first deploy), a new account sealed from the start.
 */
export async function openGrantAccount(networkConfig: NetworkConfig, recordsDir: string, say: (line: string) => void, options: OpenAccountOptions): Promise<GrantAccount> {
  const { root } = options;
  const networkId = assertAccountNetwork(networkConfig);
  const engine = await options.host.engines.for(networkId);
  const chain = await accountChainOf(engine);
  const { artefacts, context: contexts, owner } = chain;
  const progress = (event: ProgressEvent): void => say(contexts.describeProgress(event).trim());
  const network = contexts.networkOf({ networkId, node: httpOf(networkConfig.node), indexer: networkConfig.indexer, proofServer: networkConfig.proofServer });
  const context = contexts.accountContext({ network, artefacts: artefacts.artefactCache(accountArtifactsDir(root), { progress }), progress });
  const database = join(recordsDir, PRIVATE_STATE_DATABASE);
  // The account's private state is midnight-js's, which the engine's policy checks a new password against.
  const { contracts } = engine;

  const sealed = (key: Buffer): GrantAccount => ({
    chain,
    context,
    store: sealedOwnerStore(recordsDir, key),
    keys: sealedDeviceKeys(recordsDir, key, owner),
    location: { database, store: PRIVATE_STATE_STORE, password: () => sealedPrivateStatePassword(recordsDir, key, contracts.acceptsPrivateStatePassword) },
    protection: 'sealed',
    deviceReadSecret: () => sealedDeviceReadSecret(recordsDir, key),
    ownCode: () => {
      const device = sealedDeviceKeys(recordsDir, key, owner).read();
      if (device === undefined) throw new Error('The account\'s records hold no owner key.');
      return ownDeviceCode(recordsDir, key, device);
    },
  });
  if (isSealedAccount(recordsDir)) return sealed(openAccountKey(recordsDir, await unlockPassphrase(options.host, root, options.source)));

  // Caught half way through being sealed: its private state may be under its new password already.
  if (isAccountMigrating(recordsDir)) throw new AccountMigrationInterruptedError(recordsDir);
  const plainStore = owner.directoryOwnerStore(recordsDir);
  const plainKeys = owner.directoryDeviceKeys(recordsDir);
  if (plainStore.readOwner() !== undefined || plainKeys.read() !== undefined) {
    const warning = `Warning: the account in ${recordsDir} is not protected: its owner key and records are in plain text. Encrypt them with: midnight wallet protect`;
    if (options.warn !== undefined) options.warn(warning);
    else options.host.notice(warning);
    return { chain, context, store: plainStore, keys: plainKeys, location: { database, store: PRIVATE_STATE_STORE, password: () => LEGACY_STORE_PASSWORD }, protection: 'plain-text' };
  }
  return sealed(createAccountKey(recordsDir, await passphraseForNewSecret(options.host, root, options.source)));
}

/** The account's owner device, which its records hold. */
export function ownerDeviceOf(account: GrantAccount): OwnerDevice {
  const device = account.keys.read();
  if (device === undefined) throw new Error('The account\'s records hold no owner key.');
  return device;
}
