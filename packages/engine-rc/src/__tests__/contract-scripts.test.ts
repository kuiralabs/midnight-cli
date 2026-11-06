// The rc engine's contract scripts emit provider fragments; these tests
// evaluate them against the engine's midnight-js 5 / ledger-v9 packages. Only
// the mn serve RPC (`rpcCall`) is stubbed, and the script parts the contract
// runner gives every engine are plain values here (TEST_PARTS): the fragments
// read only the names of the indexer's environment variables from them.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core';
import type { ScriptParts } from '@kuiralabs/midnight-cli-core/engine';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  createWalletProvider,
  createMidnightProvider,
  assertSeamsSupportEra,
  Transaction,
  type WalletProvider,
  type MidnightProvider,
  type UnboundTransaction,
} from '@midnight-ntwrk/midnight-js-types';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { CURRENT_LEDGER_VERSION } from '@midnight-ntwrk/midnight-js-protocol/version';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { PROVIDER_IMPORTS, generateCallScript, generateDeployScript, providerSetupCode as providerSetupCodeFor, walletProviderCode } from '../contract-scripts.ts';

/** The script parts, as plain values: the fragments under test read only the indexer's environment variable names. */
const TEST_PARTS: ScriptParts = {
  prelude: '',
  rpcClientCode: () => '',
  coerceArgFn: '',
  privateStateSecretFn: '',
  witnessCandidates: [],
  indexerUrlEnv: 'MN_TEST_INDEXER_URL',
  indexerWsUrlEnv: 'MN_TEST_INDEXER_WS_URL',
};

const providerSetupCode = (networkConfig: NetworkConfig, key: string): string => providerSetupCodeFor(networkConfig, key, TEST_PARTS);

/** The indexer's URLs in the environment, as the contract runner gives a script's process them. */
const indexerEnvironment = (networkConfig: NetworkConfig): Record<string, string> => ({
  [TEST_PARTS.indexerUrlEnv]: networkConfig.indexer,
  [TEST_PARTS.indexerWsUrlEnv]: networkConfig.indexerWS!,
});

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...params: string[]
) => (...args: unknown[]) => Promise<any>;

const COIN_PK = 'aa'.repeat(32);
const ENC_PK = 'bb'.repeat(32);

const NETWORK: NetworkConfig = {
  indexer: 'http://127.0.0.1:1/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:1/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:1',
  proofServer: 'http://127.0.0.1:1',
  networkId: 'Undeployed',
};

type RpcRecord = { method: string; params: Record<string, unknown> };

/** Stub of the mn serve JSON-RPC boundary: records calls, answers from `replies`. */
function makeRpcStub(replies: Record<string, unknown>) {
  const calls: RpcRecord[] = [];
  const rpcCall = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (!(method in replies)) throw new Error(`unexpected RPC ${method}`);
    return replies[method];
  };
  return { calls, rpcCall };
}

/** Run the generated wallet/midnight provider fragment with the bindings PROVIDER_IMPORTS gives it. */
async function evalWalletProviders(rpcCall: unknown) {
  const fn = new AsyncFunction(
    'rpcCall', 'createWalletProvider', 'createMidnightProvider', 'Transaction', 'toHex', 'fromHex',
    `${walletProviderCode()}\nreturn { walletProvider, midnightProvider };`,
  );
  return await fn(rpcCall, createWalletProvider, createMidnightProvider, Transaction, toHex, fromHex) as {
    walletProvider: WalletProvider;
    midnightProvider: MidnightProvider;
  };
}

// Real ledger-v9 txs built offline: an empty intent needs no circuit proofs,
// so prove() never reaches the proving provider.
let unboundTx: UnboundTransaction;
let finalizedTx: ledger.FinalizedTransaction;

beforeAll(async () => {
  const neverProves = async () => { throw new Error('proving provider must not be called'); };
  const unproven = ledger.Transaction.fromParts(
    'undeployed', undefined, undefined, ledger.Intent.new(new Date(Date.UTC(2030, 0, 1))),
  );
  unboundTx = await unproven.prove(
    { check: neverProves, prove: neverProves, lookupKey: neverProves },
    ledger.CostModel.initialCostModel(),
  );
  finalizedTx = ledger.Transaction.fromParts(
    'undeployed', undefined, undefined, ledger.Intent.new(new Date(Date.UTC(2030, 0, 1))),
  ).mockProve();
});

describe('generated walletProvider', () => {
  it('declares the current ledger era so midnight-js 5 does not refuse it', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider, midnightProvider } = await evalWalletProviders(rpcCall);

    expect(walletProvider.supportedEras).toContain(CURRENT_LEDGER_VERSION);
    expect(midnightProvider.supportedEras).toContain(CURRENT_LEDGER_VERSION);
  });

  it('returns the keys mn serve reports', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    expect(walletProvider.getCoinPublicKey()).toBe(COIN_PK);
    expect(walletProvider.getEncryptionPublicKey()).toBe(ENC_PK);
  });

  it('balances a v9-tagged tx via balanceUnsealedTransaction and returns the sealed tx v9-tagged', async () => {
    const sealedHex = toHex(finalizedTx.serialize());
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      balanceUnsealedTransaction: { tx: sealedHex },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    const balanced = await walletProvider.balanceTx({ version: 'v9', tx: unboundTx });

    const balanceCall = calls.find((c) => c.method === 'balanceUnsealedTransaction');
    expect(balanceCall?.params).toEqual({ tx: toHex(unboundTx.serialize()) });
    expect(balanced.version).toBe('v9');
    if (balanced.version !== 'v9') throw new Error('unreachable');
    expect(balanced.tx).toBeInstanceOf(Transaction);
    expect(toHex(balanced.tx.serialize())).toBe(sealedHex);
  });

  it('surfaces an RPC rejection from mn serve', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    await expect(walletProvider.balanceTx({ version: 'v9', tx: unboundTx }))
      .rejects.toThrow('unexpected RPC balanceUnsealedTransaction');
  });
});

describe('generated midnightProvider', () => {
  it('submits the unwrapped tx hex via submitTransaction and returns its first identifier', async () => {
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      submitTransaction: { txHash: 'ignored-by-provider' },
    });
    const { midnightProvider } = await evalWalletProviders(rpcCall);

    const txId = await midnightProvider.submitTx({ version: 'v9', tx: finalizedTx });

    const submitCall = calls.find((c) => c.method === 'submitTransaction');
    expect(submitCall?.params).toEqual({ tx: toHex(finalizedTx.serialize()) });
    expect(txId).toBe(finalizedTx.identifiers()[0]);
  });
});

describe('generated providers object', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('passes the era check deployContract/findDeployedContract run first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mn-runner-'));
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider, midnightProvider } = await evalWalletProviders(rpcCall);
    const fn = new AsyncFunction(
      'MANAGED_DIR', 'walletProvider', 'midnightProvider',
      'NodeZkConfigProvider', 'httpClientProofProvider', 'indexerPublicDataProvider', 'levelPrivateStateProvider',
      `${providerSetupCode(NETWORK, 'counterPrivateState')}\nreturn providers;`,
    );
    // The generated code reads the indexer's URLs from its environment, as the script's process is given them.
    const environment = indexerEnvironment(NETWORK);
    Object.assign(process.env, environment);
    try {
      const providers = await fn(
        dir, walletProvider, midnightProvider,
        NodeZkConfigProvider, httpClientProofProvider, indexerPublicDataProvider, levelPrivateStateProvider,
      );
      try {
        expect(() => assertSeamsSupportEra(CURRENT_LEDGER_VERSION, providers)).not.toThrow();
        expect(providers.midnightProvider).toBe(midnightProvider);
      } finally {
        await providers.publicDataProvider.dispose();
      }
    } finally {
      for (const name of Object.keys(environment)) delete process.env[name];
    }
  });
});

describe('generated scripts', () => {
  const scripts = {
    deploy: generateDeployScript({
      networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, args: [1, 'x'],
    }, TEST_PARTS),
    call: generateCallScript({
      networkConfig: NETWORK, managedDir: '/tmp/dapp/managed/counter',
      contractName: 'counter', servePort: 9932, contractAddress: 'ab'.repeat(32), circuit: 'increment', args: [],
    }, TEST_PARTS),
  };

  it('includes the provider imports in deploy and call scripts', () => {
    expect(scripts.deploy).toContain(PROVIDER_IMPORTS);
    expect(scripts.call).toContain(PROVIDER_IMPORTS);
  });
});

// Regression: under bun, require.resolve('ws') answers with bun's own ws, not a
// file, so the engine found no folder for it and the contract script (run under
// Node) could not import it: a deploy from a program on bun failed.
describe('packageFolder on bun', () => {
  const bunInstalled = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!bunInstalled)('finds the installed ws, a folder holding its package.json, where bun answers with its own', () => {
    const source = fileURLToPath(new URL('../contract-scripts.ts', import.meta.url));
    const found = spawnSync('bun', ['--conditions=midnight-cli-source', '-e', `const { packageFolder } = await import(${JSON.stringify(source)}); console.log(packageFolder('ws'));`], { encoding: 'utf8' });
    const folder = found.stdout.trim();
    expect(folder, found.stderr).toMatch(/node_modules\/ws$/);
    expect(existsSync(join(folder, 'package.json'))).toBe(true);
  });
});
