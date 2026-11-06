// Grant reaches the account package through the engine of the network's SDK
// set. On a local network that is the rc engine: its copy of the package,
// whose Midnight libraries resolve to the rc set, runs the release
// candidates' contract build, which pins callers, so a request that pins its
// calling contract is prepared as it always was. Nothing here reaches a chain.
// (The beta engine's copy: engine-beta-account-chain.test.ts.)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, parseArgs } from '@kuiralabs/midnight-cli-core';
import { resolvedPackageFolder } from '@kuiralabs/midnight-cli-core/engine';
import { accountChainFor } from '../lib/grant/account-chain.ts';
import { prepareGrant } from '../lib/grant/prepare.ts';
import { agentLink } from '../../../../test-support/grant-request-links.ts';
import { stateRootIn } from '../../../../test-support/state-root-in.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

const ENGINE_DIR = new URL('../../../engine-rc', import.meta.url).pathname;
const ACCOUNT_PACKAGE = '@kuiralabs/midnight-account-chain';
const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];
// An account's records as mn 0.6.0-rc.10 left them.
const ACCOUNT = '5e'.repeat(32);
const OWNER_RECORD = { contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };

let home: string;
// The host the tests' calls run in: nobody to ask, notices dropped, its state root under the test's home, and the engines the CLI ships.
const host = createHost({ engineLoader: loadInstalledEngine, paths: () => ({ stateRoot: stateRootIn(home), home }) });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-chain-rc-')));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** The folder of the package's copy a loaded build is in: its build directory is <copy>/dist/managed/<build>. */
const copyOf = (accountBuild: string): string => path.resolve(accountBuild, '..', '..', '..');

describe('the account package on a local network', () => {
  it('is the rc engine\'s copy, as the engine loads it', async () => {
    const engine = await host.engines.for('undeployed');
    const chain = await accountChainFor(host.engines, 'undeployed');
    const loaded = await engine.account();
    for (const entry of ['artefacts', 'connector', 'context', 'contract', 'deposit', 'errors', 'owner'] as const) expect(chain[entry], entry).toBe(loaded[entry]);
    expect(copyOf(chain.contract.ACCOUNT_BUILD)).toBe(resolvedPackageFolder(ENGINE_DIR, ACCOUNT_PACKAGE));
  });

  it('resolves its compact runtime to the rc engine\'s, and runs the build with the caller pin', async () => {
    const engine = await host.engines.for('undeployed');
    const { contract, owner } = await accountChainFor(host.engines, 'undeployed');
    const runtime = resolvedPackageFolder(copyOf(contract.ACCOUNT_BUILD), '@midnight-ntwrk/compact-runtime')!;
    expect(JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8')).version).toBe(engine.contracts.scripts.compactRuntimeVersion);
    expect(engine.contracts.scripts.compactRuntimeVersion).toBe('0.21.0');
    expect(contract.ACCOUNT_BUILD_NAME).toBe('Account');
    expect(path.basename(contract.ACCOUNT_BUILD)).toBe('Account');
    expect(contract.supportsCallerPin()).toBe(true);
    expect(owner.supportsCallerPin()).toBe(true);
  });

  it('prepares an issue of a request that pins its calling contract, shown or confirmed', async () => {
    const records = path.join(stateRootIn(home), 'accounts', 'undeployed', 'alice');
    fs.mkdirSync(records, { recursive: true });
    fs.writeFileSync(path.join(records, 'owner.json'), JSON.stringify(OWNER_RECORD));
    const link = await agentLink(resolvedPackageFolder(ENGINE_DIR, ACCOUNT_PACKAGE)!, ACCOUNT, new Uint8Array(32).fill(0xc4));
    for (const confirm of [[], ['--yes']]) {
      const prepared = await prepareGrant(parseArgs(['grant', 'issue', link, ...confirm, '--wallet', 'alice', ...ENDPOINTS]), stateRootIn(home), host);
      expect(prepared.request).toMatchObject({ subcommand: 'issue', link, confirmed: confirm.length === 1 });
      expect(prepared.account).toEqual({ address: ACCOUNT });
    }
  });
});
