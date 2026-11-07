// A dApp's private-state store, opened as the deploy and call scripts open it,
// against midnight-js's real level provider in a temporary folder: kept to its
// owner on disk, encrypted with the wallet's own password, and a store an mn
// before 0.6.0 wrote (one fixed password, one shared account) taken over by
// the first wallet that opens it, once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { contractKeysFromSeed } from '@kuiralabs/midnight-cli-core';
import { openPrivateStateStore, type PrivateStateStoreDeps } from '../lib/contract/private-state-store.ts';

const LEGACY_PASSWORD = 'mn-contract-default-pwd-16ch';
const LEGACY_ACCOUNT = 'mn-contract-runner';
const STORE = 'counterPrivateState';
const CONTRACT = 'ab'.repeat(32);
const ALICE = contractKeysFromSeed(Buffer.alloc(32, 1));
const BOB = contractKeysFromSeed(Buffer.alloc(32, 2));

let work: string;
let dir: string;
let umaskBefore: number;

// The deps the script passes: node's own, and the real provider.
const deps: PrivateStateStoreDeps = {
  fs,
  join: path.join,
  provide: (value) => () => value,
  umask: (mask) => process.umask(mask),
  levelPrivateStateProvider: levelPrivateStateProvider as unknown as PrivateStateStoreDeps['levelPrivateStateProvider'],
};

const provider = (password: string, accountId: string) => levelPrivateStateProvider({
  midnightDbName: dir,
  privateStateStoreName: STORE,
  privateStoragePasswordProvider: () => password,
  accountId,
});

const open = (keys: typeof ALICE) => openPrivateStateStore(deps, { dir, storeName: STORE, password: keys.storagePassword, accountId: keys.storageAccountId });

const mode = (file: string) => fs.statSync(file).mode & 0o777;

beforeEach(() => {
  umaskBefore = process.umask();
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-private-state-'));
  dir = path.join(work, 'midnight-level-db');
});

afterEach(() => {
  process.umask(umaskBefore);
  fs.rmSync(work, { recursive: true, force: true });
});

describe('openPrivateStateStore', () => {
  it('makes a new store the owner\'s only, and its entries readable only with the wallet\'s password', async () => {
    const { accountId } = await open(ALICE);
    expect(accountId).toBe(ALICE.storageAccountId);
    const store = provider(ALICE.storagePassword, accountId);
    await store.forContract(CONTRACT).set('counter', { secret: 7 });
    expect(mode(dir)).toBe(0o700);
    for (const name of fs.readdirSync(dir)) expect(mode(path.join(dir, name)), name).toBe(0o600);
    expect(await provider(ALICE.storagePassword, accountId).forContract(CONTRACT).get('counter')).toEqual({ secret: 7 });
    // The fixed password of an mn before 0.6.0 opens nothing.
    await expect(provider(LEGACY_PASSWORD, accountId).forContract(CONTRACT).get('counter')).rejects.toThrow();
  });

  it('tightens a store an older mn left open to others', async () => {
    process.umask(0o022);
    await provider(LEGACY_PASSWORD, LEGACY_ACCOUNT).forContract(CONTRACT).set('counter', { secret: 1 });
    expect(mode(dir)).toBe(0o755);
    await open(ALICE);
    expect(mode(dir)).toBe(0o700);
    for (const name of fs.readdirSync(dir)) expect(mode(path.join(dir, name)), name).toBe(0o600);
  });

  it('has the first wallet take over an older mn\'s store, its state and signing keys re-encrypted with its own password, once', async () => {
    const legacy = provider(LEGACY_PASSWORD, LEGACY_ACCOUNT);
    await legacy.forContract(CONTRACT).set('counter', { secret: 42 });
    await legacy.setSigningKey(CONTRACT, 'cd'.repeat(32) as never);

    const { accountId } = await open(ALICE);
    expect(accountId).toBe(LEGACY_ACCOUNT);
    const mine = provider(ALICE.storagePassword, accountId);
    expect(await mine.forContract(CONTRACT).get('counter')).toEqual({ secret: 42 });
    expect(await mine.getSigningKey(CONTRACT)).not.toBeNull();
    await expect(provider(LEGACY_PASSWORD, LEGACY_ACCOUNT).forContract(CONTRACT).get('counter')).rejects.toThrow();

    // Opened again: nothing is rotated twice, and the entries stay readable.
    expect(await open(ALICE)).toEqual({ accountId: LEGACY_ACCOUNT });
    expect(await provider(ALICE.storagePassword, LEGACY_ACCOUNT).forContract(CONTRACT).get('counter')).toEqual({ secret: 42 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mn-private-state.json'), 'utf8'))).toEqual({
      version: 1, legacyOwner: ALICE.storageAccountId, rotated: [STORE, '(signing keys)'],
    });
  });

  it('keeps another wallet\'s entries apart: its own account, its own password', async () => {
    await provider(LEGACY_PASSWORD, LEGACY_ACCOUNT).forContract(CONTRACT).set('counter', { secret: 42 });
    await open(ALICE);
    const { accountId } = await open(BOB);
    expect(accountId).toBe(BOB.storageAccountId);
    const bobs = provider(BOB.storagePassword, accountId);
    expect(await bobs.forContract(CONTRACT).get('counter')).toBeNull();
    await bobs.forContract(CONTRACT).set('counter', { secret: 9 });
    // Alice's taken-over entries are untouched by Bob's.
    expect(await provider(ALICE.storagePassword, LEGACY_ACCOUNT).forContract(CONTRACT).get('counter')).toEqual({ secret: 42 });
  });

  it('refuses to run without the wallet\'s password and account, and a record it can\'t read', async () => {
    await expect(openPrivateStateStore(deps, { dir, storeName: STORE, password: undefined, accountId: 'x' })).rejects.toThrow(/MN_PRIVATE_STATE_PASSWORD/);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mn-private-state.json'), '{not json');
    await expect(open(ALICE)).rejects.toThrow(/could not be read/);
  });
});
