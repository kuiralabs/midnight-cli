// Where a contract's private state is kept: under mn's state root, one store
// per contract by network and address; a store an earlier mn kept in the
// dApp's folder is moved out once, and a call of a contract with no store
// yet starts from a copy of it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callStateDir, clearNetworkContractState, contractStateDir, deployStateDir, dropEmptyDeployState, keepDeployState, moveDappStore, movedDappStoreDir } from '../lib/contract/private-state.ts';

const ADDRESS = 'AB'.repeat(32);
let home: string;
let root: string;
let dapp: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-private-state-place-'));
  root = join(home, '.midnight');
  dapp = join(home, 'my-dapp');
  mkdirSync(dapp, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A store as LevelDB leaves it, in `dir`. */
function store(dir: string, data = 'state'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  writeFileSync(join(dir, '000003.log'), data);
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe('the private-state store of a contract', () => {
  it('is under the state root, by network and address (lower-case)', () => {
    expect(contractStateDir(root, 'undeployed', ADDRESS)).toBe(join(root, 'contract-state', 'undeployed', 'ab'.repeat(32)));
  });

  it('is a deploy\'s own until it is filed under the contract\'s address, every folder the owner\'s only', () => {
    const staging = deployStateDir(root, 'preview');
    store(staging);
    expect(keepDeployState(staging, root, 'preview', ADDRESS)).toBe(contractStateDir(root, 'preview', ADDRESS));
    expect(existsSync(staging)).toBe(false);
    expect(readFileSync(join(contractStateDir(root, 'preview', ADDRESS), '000003.log'), 'utf8')).toBe('state');
    for (const dir of [join(root, 'contract-state'), join(root, 'contract-state', 'preview')]) expect(mode(dir), dir).toBe(0o700);
  });

  it('keeps a deploy\'s store where it is when the address has one already', () => {
    store(contractStateDir(root, 'preview', ADDRESS), 'first');
    const staging = deployStateDir(root, 'preview');
    store(staging, 'second');
    expect(keepDeployState(staging, root, 'preview', ADDRESS)).toBe(staging);
    expect(readFileSync(join(contractStateDir(root, 'preview', ADDRESS), '000003.log'), 'utf8')).toBe('first');
  });

  it('drops a failed deploy\'s store only when it holds nothing but mn\'s record', () => {
    const empty = deployStateDir(root, 'undeployed');
    mkdirSync(empty);
    writeFileSync(join(empty, 'mn-private-state.json'), '{}');
    expect(dropEmptyDeployState(empty)).toBe(true);
    expect(existsSync(empty)).toBe(false);
    const written = deployStateDir(root, 'undeployed');
    store(written);
    expect(dropEmptyDeployState(written)).toBe(false);
    expect(existsSync(written)).toBe(true);
  });

  it('of a local chain all go when it is reset', () => {
    store(contractStateDir(root, 'undeployed', ADDRESS));
    store(contractStateDir(root, 'preview', ADDRESS));
    expect(clearNetworkContractState(root, 'undeployed')).toBe(true);
    expect(existsSync(contractStateDir(root, 'undeployed', ADDRESS))).toBe(false);
    expect(existsSync(contractStateDir(root, 'preview', ADDRESS))).toBe(true);
    expect(clearNetworkContractState(root, 'undeployed')).toBe(false);
  });
});

describe('a store an earlier mn kept in the dApp', () => {
  it('is moved out of the dApp once, owner-only, and says where', () => {
    store(join(dapp, 'midnight-level-db'));
    const moved = moveDappStore(root, dapp);
    expect(moved).toEqual({ from: join(dapp, 'midnight-level-db'), to: movedDappStoreDir(root, dapp) });
    expect(existsSync(join(dapp, 'midnight-level-db'))).toBe(false);
    expect(readFileSync(join(moved!.to, '000003.log'), 'utf8')).toBe('state');
    expect(mode(moved!.to)).toBe(0o700);
    expect(moveDappStore(root, dapp)).toBeUndefined();
  });

  it('found again after one was moved, goes beside it', () => {
    store(join(dapp, 'midnight-level-db'), 'old');
    const first = moveDappStore(root, dapp)!;
    store(join(dapp, 'midnight-level-db'), 'newer');
    const second = moveDappStore(root, dapp)!;
    expect(second.to).not.toBe(first.to);
    expect(readFileSync(join(first.to, '000003.log'), 'utf8')).toBe('old');
    expect(readFileSync(join(second.to, '000003.log'), 'utf8')).toBe('newer');
  });

  it('is copied for a contract a call finds no store of its own for, and the call reads its own from then on', () => {
    store(join(dapp, 'midnight-level-db'));
    moveDappStore(root, dapp);
    const first = callStateDir(root, 'undeployed', ADDRESS, dapp);
    expect(first).toEqual({ dir: contractStateDir(root, 'undeployed', ADDRESS), copiedFrom: movedDappStoreDir(root, dapp) });
    expect(readFileSync(join(first.dir, '000003.log'), 'utf8')).toBe('state');
    expect(existsSync(join(movedDappStoreDir(root, dapp), 'CURRENT'))).toBe(true);
    expect(callStateDir(root, 'undeployed', ADDRESS, dapp)).toEqual({ dir: contractStateDir(root, 'undeployed', ADDRESS) });
  });

  it('a call from another folder, with no store moved from it, uses the contract\'s store as it is', () => {
    store(contractStateDir(root, 'undeployed', ADDRESS), 'deployed');
    expect(callStateDir(root, 'undeployed', ADDRESS, join(home, 'elsewhere'))).toEqual({ dir: contractStateDir(root, 'undeployed', ADDRESS) });
  });
});
