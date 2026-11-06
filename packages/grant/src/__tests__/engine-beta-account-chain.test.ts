// Grant on stagenet reaches the account package through the beta engine: its
// own copy, nested in its folder so the package's Midnight libraries resolve
// to the beta set. That copy runs the stagenet contract build, which pins no
// caller, so an issue of a request that pins its calling contract is refused
// as it is prepared, before any wallet is opened. Nothing here reaches a
// chain. Its own process: the beta set beside nothing else (the rc engine's
// copy: grant-account-chain.test.ts).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, parseArgs } from '@kuiralabs/midnight-cli-core';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/engine';
import { accountChainFor } from '../lib/grant/account-chain.ts';
import { CallerPinUnavailableError } from '../lib/grant/account-errors.ts';
import { prepareGrant } from '../lib/grant/prepare.ts';
import { agentLink } from '../../../../test-support/grant-request-links.ts';
import { stateRootIn } from '../../../../test-support/state-root-in.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

const ENGINE_DIR = new URL('../../../engine-beta', import.meta.url).pathname;
const ROOT = new URL('../../../..', import.meta.url).pathname;
const ACCOUNT_PACKAGE = '@kuiralabs/midnight-account-chain';
const ENDPOINTS = ['--node', 'ws://127.0.0.1:9', '--indexer-ws', 'ws://127.0.0.1:9/api/v4/graphql/ws', '--proof-server', 'http://127.0.0.1:9'];
// An account's records as an earlier mn left them, read by the beta copy of the package.
const ACCOUNT = '5e'.repeat(32);
const OWNER_RECORD = { contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };
const CALLER = new Uint8Array(32).fill(0xc4);

let home: string;
// The host the tests' calls run in: nobody to ask, notices dropped, its state root under the test's home, and the engines the CLI ships.
const host = createHost({ engineLoader: loadInstalledEngine, paths: () => ({ stateRoot: stateRootIn(home), home }) });
const recordsOf = (wallet: string) => path.join(stateRootIn(home), 'accounts', 'stagenet', wallet);
const prepare = (...argv: string[]) => prepareGrant(parseArgs(['grant', ...argv, '--wallet', 'alice', '--network', 'stagenet', ...ENDPOINTS]), stateRootIn(home), host);
const withAccount = () => {
  fs.mkdirSync(recordsOf('alice'), { recursive: true });
  fs.writeFileSync(path.join(recordsOf('alice'), 'owner.json'), JSON.stringify(OWNER_RECORD));
};
const betaCopy = () => resolvedPackageFolder(ENGINE_DIR, ACCOUNT_PACKAGE)!;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-chain-beta-')));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** The folder of the package's copy a loaded build is in: its build directory is <copy>/dist/managed/<build>. */
const copyOf = (accountBuild: string): string => path.resolve(accountBuild, '..', '..', '..');

describe('the account package on stagenet', () => {
  it('is the beta engine\'s own copy, as the engine loads it, not the one at the root', async () => {
    const engine = await host.engines.for('stagenet');
    expect(engine.set).toBe('beta');
    const chain = await accountChainFor(host.engines, 'stagenet');
    const loaded = await engine.account();
    for (const entry of ['artefacts', 'connector', 'context', 'contract', 'deposit', 'errors', 'owner'] as const) expect(chain[entry], entry).toBe(loaded[entry]);
    expect(copyOf(chain.contract.ACCOUNT_BUILD)).toBe(betaCopy());
    expect(betaCopy()).not.toBe(resolvedPackageFolder(ROOT, ACCOUNT_PACKAGE));
  });

  it('resolves its compact runtime to the beta engine\'s, and runs the stagenet build, which pins no caller', async () => {
    const engine = await host.engines.for('stagenet');
    const { contract, owner } = await accountChainFor(host.engines, 'stagenet');
    const runtime = resolvedPackageFolder(copyOf(contract.ACCOUNT_BUILD), '@midnight-ntwrk/compact-runtime')!;
    expect(JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).version).toBe(engine.contracts.scripts.compactRuntimeVersion);
    expect(engine.contracts.scripts.compactRuntimeVersion).toBe('0.18.0-rc.1');
    expect(contract.ACCOUNT_BUILD_NAME).toBe('AccountStagenet');
    expect(path.basename(contract.ACCOUNT_BUILD)).toBe('AccountStagenet');
    expect(contract.supportsCallerPin()).toBe(false);
    expect(owner.supportsCallerPin()).toBe(false);
  });
});

describe('preparing mn grant on stagenet', () => {
  it('prepares the deploy of a new account, its records under stagenet', async () => {
    fs.mkdirSync(path.join(stateRootIn(home), 'wallets'), { recursive: true });
    fs.writeFileSync(path.join(stateRootIn(home), 'wallets', 'alice.json'), '{}');
    const prepared = await prepare('deploy');
    expect(prepared.target.network).toBe('stagenet');
    expect(prepared.account).toBeNull();
    expect(prepared.recordsDir).toBe(recordsOf('alice'));
  });

  it('reads an account on record with the beta copy of the package', async () => {
    withAccount();
    expect((await prepare('status')).account).toEqual({ address: ACCOUNT });
  });

  it('refuses an issue of a request that pins its calling contract, shown or confirmed, with CALLER_PIN_UNSUPPORTED', async () => {
    withAccount();
    const link = await agentLink(betaCopy(), ACCOUNT, CALLER);
    for (const confirm of [[], ['--yes']]) {
      const refused = prepare('issue', link, ...confirm);
      await expect(refused).rejects.toThrow(CallerPinUnavailableError);
      await expect(refused).rejects.toMatchObject({ code: 'CALLER_PIN_UNSUPPORTED' });
      await expect(refused).rejects.toThrow(`The grant request pins the contract that calls the account (${'c4'.repeat(32)}), and the account on stagenet can't pin a caller`);
    }
  });

  it('prepares an issue of a request that names no calling contract', async () => {
    withAccount();
    const link = await agentLink(betaCopy(), ACCOUNT);
    expect((await prepare('issue', link, '--yes')).request).toMatchObject({ subcommand: 'issue', link, confirmed: true });
  });

  it('refuses a link that is not a grant request as a usage error', async () => {
    withAccount();
    await expect(prepare('issue', 'midnight-example:grant-request?r=AAECAw')).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  });
});
