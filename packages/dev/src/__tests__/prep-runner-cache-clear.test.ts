// The cache-clear prep step clears the sync caches of the wallets a test run
// uses, and leaves every other wallet's alone. Nothing reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHost, createSdkWarningRouter, GENESIS_SEED, saveCliConfig } from '@kuiralabs/midnight-cli-core';
import { getCachePath } from '@kuiralabs/midnight-cli-core/engine';
import { runPrepSteps } from '../lib/test/prep-runner.ts';
import { createPrepContext, type DappTestConfig } from '../lib/test/types.ts';
import { rcKeys } from '../../../../test-support/rc-engine.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';

const SEEDS = { alice: Buffer.alloc(32, 3), bob: Buffer.alloc(32, 9) };
const address = (seed: Buffer) => rcKeys.unshieldedAddresses(seed).undeployed;
const GENESIS = address(Buffer.from(GENESIS_SEED, 'hex'));

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-prep-cache-clear-'));
  root = join(home, '.midnight');
  for (const [name, seed] of Object.entries(SEEDS)) {
    saveWalletConfig({ seed: seed.toString('hex'), addresses: rcKeys.unshieldedAddresses(seed), createdAt: new Date(0).toISOString() }, join(root, 'wallets', `${name}.json`));
  }
  saveCliConfig({ network: 'undeployed', wallet: 'alice' }, root);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A sync cache on record for `walletAddress` on the local network. */
function cached(walletAddress: string): string {
  const file = getCachePath(walletAddress, 'undeployed', root);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}');
  return file;
}

describe('the cache-clear prep step', () => {
  // Regression: it cleared every wallet's sync cache for the network.
  it('clears the active wallet\'s and the genesis wallet\'s, and keeps every other wallet\'s', async () => {
    const files = { alice: cached(address(SEEDS.alice)), genesis: cached(GENESIS), bob: cached(address(SEEDS.bob)) };
    const host = createHost({ paths: { stateRoot: root, home }, engineLoader: loadInstalledEngine });
    await runPrepSteps({ network: 'undeployed', prep: ['cache-clear'] } as unknown as DappTestConfig, home, createPrepContext(root, host, createSdkWarningRouter().openCall().warnings, new AbortController().signal), { onStepStart: () => {}, onStepComplete: () => {}, onMessage: () => {} });
    expect({ alice: existsSync(files.alice), genesis: existsSync(files.genesis), bob: existsSync(files.bob) }).toEqual({ alice: false, genesis: false, bob: true });
  });
});
