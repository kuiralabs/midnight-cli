// What `mn grant` gives the account package (@kuiralabs/midnight-account-chain),
// which it calls in its own process: the network it acts on, where the proving
// keys are cached, its progress, and the account's records, device key and
// private state, all in the account's records directory.
//
// The records are where every account so far keeps them, so an account made by
// an earlier mn opens unchanged: owner.json (the account's records and its
// owner key) and roster.json, with the private state in the directory's
// midnight-level-db under the store name and password it was first made with.

import { anyEngine } from '@kuiralabs/midnight-cli-core/lib/engine';
import { join } from 'node:path';
import { artefactCache } from '@kuiralabs/midnight-account-chain/artefacts';
import { type AccountContext, type ProgressEvent, accountContext, describeProgress, networkOf } from '@kuiralabs/midnight-account-chain/context';
import {
  type DirectoryDeviceKeys,
  type OwnerDevice,
  type OwnerStore,
  type PrivateStateLocation,
  directoryDeviceKeys,
  directoryOwnerStore,
} from '@kuiralabs/midnight-account-chain/owner';
import { PRIVATE_STATE_DATABASE } from '../contract/private-state.ts';
import { type PassphraseSource, passphraseForNewSecret, unlockPassphrase } from '../passphrase.ts';
import type { UnlockHost } from '../wallet-config.ts';
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
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { isValidNetworkName, sdkSetOfNetwork, type NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import type { SdkSet } from '@kuiralabs/midnight-cli-core/lib/engine';

/** Where the account package caches its proving artefacts, under ~/.midnight: each file is fetched the first time a command proves with it. */
const ACCOUNT_ARTIFACTS_DIR_NAME = 'account-artifacts';

export function accountArtifactsDir(root: string): string {
  return join(root, ACCOUNT_ARTIFACTS_DIR_NAME);
}

/** The network the account package acts on: ledger 9, which only a local network runs so far. */
const ACCOUNT_NETWORK_ID = 'undeployed';

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

/** A network the account package can't reach yet. */
export class UnreachableByAccountError extends UsageError {
  constructor(networkId: string, sdkSet: SdkSet = 'rc') {
    super(sdkSet === 'rc'
      ? `mn grant runs on ledger 9, which only a local network (undeployed) runs so far; ${networkId} is not one.`
      // The account package is built on the rc set: its contracts, proving files and providers.
      : `mn grant runs on the rc SDK set, and ${networkId} runs on the ${sdkSet} set. The account package has no ${sdkSet} build yet (its contracts need recompiling and new proving files), so grant can't act on it for now.`);
    this.name = 'UnreachableByAccountError';
    Object.setPrototypeOf(this, UnreachableByAccountError.prototype);
  }
}

/** Throws when the account package can't act on `networkConfig`'s network, by the SDK set the config under the state root `root` gives it. */
export function assertAccountNetwork(networkConfig: NetworkConfig, root: string): void {
  const id = networkConfig.networkId.toLowerCase();
  const sdkSet = isValidNetworkName(id) ? sdkSetOfNetwork(id, root) : 'rc';
  if (sdkSet !== 'rc') throw new UnreachableByAccountError(networkConfig.networkId, sdkSet);
  if (networkConfig.networkId.toLowerCase() !== ACCOUNT_NETWORK_ID) throw new UnreachableByAccountError(networkConfig.networkId);
}

/** The Node.js the account package needs: it declares 22.18 or newer. */
export const MIN_NODE_FOR_ACCOUNT = '22.18.0';

/** This Node.js is older than the account package needs. */
export class NodeTooOldForAccountError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(`mn grant runs the account package, which needs Node.js ${MIN_NODE_FOR_ACCOUNT} or newer; this is Node.js ${version}. Install a current Node.js (https://nodejs.org) and run the command again.`);
    this.name = 'NodeTooOldForAccountError';
    Object.setPrototypeOf(this, NodeTooOldForAccountError.prototype);
  }
}

/** Throws when this Node.js is older than the account package needs. */
export function assertNodeRunsAccount(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_NODE_FOR_ACCOUNT.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new NodeTooOldForAccountError(version);
}

/** The node's http(s) form: mn keeps it as the WebSocket URL its wallet connects to. */
const httpOf = (url: string): string => url.replace(/^ws/, 'http');

/** How an account's records are kept: sealed under mn's passphrase, or in plain text as an earlier mn wrote them. */
export type AccountProtection = 'sealed' | 'plain-text';

/** Everything the account package needs to act on one wallet's account. */
export interface GrantAccount {
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
  /** The host: who is asked for the passphrase, the passphrase it has unlocked, and its notices. */
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
  assertAccountNetwork(networkConfig, root);
  const progress = (event: ProgressEvent): void => say(describeProgress(event).trim());
  const network = networkOf({ networkId: ACCOUNT_NETWORK_ID, node: httpOf(networkConfig.node), indexer: networkConfig.indexer, proofServer: networkConfig.proofServer });
  const context = accountContext({ network, artefacts: artefactCache(accountArtifactsDir(root), { progress }), progress });
  const database = join(recordsDir, PRIVATE_STATE_DATABASE);
  // The account's private state is midnight-js's, which the engine's policy checks a new password against.
  const { contracts } = await anyEngine();

  const sealed = (key: Buffer): GrantAccount => ({
    context,
    store: sealedOwnerStore(recordsDir, key),
    keys: sealedDeviceKeys(recordsDir, key),
    location: { database, store: PRIVATE_STATE_STORE, password: () => sealedPrivateStatePassword(recordsDir, key, contracts.acceptsPrivateStatePassword) },
    protection: 'sealed',
    deviceReadSecret: () => sealedDeviceReadSecret(recordsDir, key),
    ownCode: () => {
      const device = sealedDeviceKeys(recordsDir, key).read();
      if (device === undefined) throw new Error('The account\'s records hold no owner key.');
      return ownDeviceCode(recordsDir, key, device);
    },
  });
  if (isSealedAccount(recordsDir)) return sealed(openAccountKey(recordsDir, await unlockPassphrase(options.host, root, options.source)));

  // Caught half way through being sealed: its private state may be under its new password already.
  if (isAccountMigrating(recordsDir)) throw new AccountMigrationInterruptedError(recordsDir);
  const plainStore = directoryOwnerStore(recordsDir);
  const plainKeys = directoryDeviceKeys(recordsDir);
  if (plainStore.readOwner() !== undefined || plainKeys.read() !== undefined) {
    const warning = `Warning: the account in ${recordsDir} is not protected: its owner key and records are in plain text. Encrypt them with: midnight wallet protect`;
    if (options.warn !== undefined) options.warn(warning);
    else options.host.notice(warning);
    return { context, store: plainStore, keys: plainKeys, location: { database, store: PRIVATE_STATE_STORE, password: () => LEGACY_STORE_PASSWORD }, protection: 'plain-text' };
  }
  return sealed(createAccountKey(recordsDir, await passphraseForNewSecret(options.host, root, options.source)));
}

/** The account's owner device, which its records hold. */
export function ownerDeviceOf(account: GrantAccount): OwnerDevice {
  const device = account.keys.read();
  if (device === undefined) throw new Error('The account\'s records hold no owner key.');
  return device;
}
