// Where a contract's private state is kept: the LevelDB store the midnight-js
// private state provider writes (the contract's private state and its signing
// keys), one store per contract, under mn's state root:
//
//   <state root>/contract-state/<network>/<contract address>/
//
// By the contract's address, not the dApp's folder: a call from any folder
// finds the state its deploy left, two dApps that both name their contract
// "counter" never share one, and a chain's stores sit together, so resetting
// a local chain clears them all. A deploy, whose address is known only once
// it is made, writes into a store of its own under the network and renames it
// to its address when the deploy returns it.
//
// An mn before this one kept the store in the dApp's folder
// (`<dApp>/midnight-level-db`), one per folder whatever the network or the
// contract. It is moved out of the dApp once, to
// `<state root>/contract-state/from-dapp-folders/<folder>-<hash>/`; a call of
// a contract with no store of its own yet starts from a copy of it, as the
// call would have read it before.

import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { NetworkName } from '@kuiralabs/midnight-cli-core';

/** The name of the store's folder in a dApp, where an mn before this one kept it. */
export const PRIVATE_STATE_DATABASE = 'midnight-level-db';

/** The folder under the state root holding every contract's private state. */
const CONTRACT_STATE = 'contract-state';
/** Where stores moved out of dApp folders are kept, under CONTRACT_STATE. */
const FROM_DAPP_FOLDERS = 'from-dapp-folders';

/** Makes `dir` and its parents up to the state root, each the owner's only. */
function ownerOnlyDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The private-state store of the contract at `address` on `network`. */
export function contractStateDir(root: string, network: NetworkName, address: string): string {
  return join(root, CONTRACT_STATE, network, address.toLowerCase());
}

/** The folder holding every contract's store on `network`. */
export function networkContractStateDir(root: string, network: NetworkName): string {
  return join(root, CONTRACT_STATE, network);
}

/** Where the store an earlier mn kept in `dappDir` is moved: named by the folder and a hash of its absolute path. */
export function movedDappStoreDir(root: string, dappDir: string): string {
  const absolute = resolve(dappDir);
  const hash = createHash('sha256').update(absolute).digest('hex').slice(0, 12);
  return join(root, CONTRACT_STATE, FROM_DAPP_FOLDERS, `${basename(absolute) || 'root'}-${hash}`);
}

/** Every file under `dir` with its size, by its path from `dir`. */
function filesOf(dir: string): Map<string, number> {
  const files = new Map<string, number>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else files.set(relative(dir, path), stat.size);
    }
  };
  walk(dir);
  return files;
}

/** Copies the store at `from` to `to`, and checks every file arrived whole; throws, leaving `from` as it was, when one didn't. */
function copyStore(from: string, to: string): void {
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  chmodSync(to, 0o700);
  const sent = filesOf(from);
  const arrived = filesOf(to);
  const missing = [...sent].filter(([file, size]) => arrived.get(file) !== size).map(([file]) => file);
  if (missing.length > 0) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(`Copying the private-state store ${from} to ${to} left ${missing.length} file(s) short (${missing.slice(0, 3).join(', ')}); the store is left where it was.`);
  }
}

/**
 * Moves the store an earlier mn kept in `dappDir` out of it, once: to
 * movedDappStoreDir (renamed, or copied, checked and then removed across
 * filesystems). Returns where it went, or undefined when the dApp has none.
 * A dApp store found again after one was moved (an older mn ran there since)
 * goes beside it under a name of its own.
 */
export function moveDappStore(root: string, dappDir: string): { from: string; to: string } | undefined {
  const from = resolve(dappDir, PRIVATE_STATE_DATABASE);
  if (!existsSync(from)) return undefined;
  let to = movedDappStoreDir(root, dappDir);
  if (existsSync(to)) to = `${to}-${randomUUID().slice(0, 8)}`;
  ownerOnlyDir(join(to, '..'));
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyStore(from, to);
    rmSync(from, { recursive: true, force: true });
  }
  chmodSync(to, 0o700);
  return { from, to };
}

/**
 * The store a call of the contract at `address` uses, and, when it had none
 * yet and the dApp's store was moved out of `dappDir`, the store it was
 * started from (a copy of that one, as the call read it before).
 */
export function callStateDir(root: string, network: NetworkName, address: string, dappDir: string): { dir: string; copiedFrom?: string } {
  const dir = contractStateDir(root, network, address);
  if (existsSync(dir)) return { dir };
  const moved = movedDappStoreDir(root, dappDir);
  ownerOnlyDir(join(dir, '..'));
  if (!existsSync(moved)) return { dir };
  copyStore(moved, dir);
  return { dir, copiedFrom: moved };
}

/** A store of its own for a deploy, under the network: renamed to the contract's address when the deploy returns it (keepDeployState). */
export function deployStateDir(root: string, network: NetworkName): string {
  const parent = networkContractStateDir(root, network);
  ownerOnlyDir(parent);
  return join(parent, `.deploying-${randomUUID()}`);
}

/**
 * Files the deploy's store as the store of the contract it made at
 * `address`. Returns its place; a store already there (the same address
 * deployed twice, which a chain refuses) is kept, and the deploy's stays
 * where it is, returned instead.
 */
export function keepDeployState(staging: string, root: string, network: NetworkName, address: string): string {
  const dir = contractStateDir(root, network, address);
  if (!existsSync(staging) || existsSync(dir)) return existsSync(staging) ? staging : dir;
  renameSync(staging, dir);
  return dir;
}

/** Removes the store of a deploy that failed before writing anything but mn's own record; one with data is kept. True iff it was removed. */
export function dropEmptyDeployState(staging: string): boolean {
  if (!existsSync(staging)) return false;
  if (readdirSync(staging).some((name) => name !== 'mn-private-state.json')) return false;
  rmSync(staging, { recursive: true, force: true });
  return true;
}

/** Removes every contract's store on `network` (its chain was reset). True iff there were some and they are gone. */
export function clearNetworkContractState(root: string, network: NetworkName): boolean {
  const dir = networkContractStateDir(root, network);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Removes the store an earlier mn kept in `dappDir`. True iff there was one and it is gone. */
export function clearDappPrivateState(dappDir: string): boolean {
  const dir = resolve(dappDir, PRIVATE_STATE_DATABASE);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
