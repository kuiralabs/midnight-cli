// The rc engine's contract scripts emit provider fragments; these tests
// evaluate them against the engine's midnight-js 5 / ledger-v9 packages. Only
// the mn serve RPC (`rpcCall`) is stubbed, and the script parts the contract
// runner gives every engine are plain values here (TEST_PARTS): the fragments
// read only the names of the indexer's environment variables from them.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { type NetworkConfig, PRICE_TRANSACTION_METHOD } from '@kuiralabs/midnight-cli-core';
import type { ScriptParts } from '@kuiralabs/midnight-cli-core/engine';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  createLedger9WalletProvider,
  createLedger9MidnightProvider,
  assertProvidersSupportEra,
  LedgerTransaction,
  type WalletProvider,
  type MidnightProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { toHex, fromHex } from '@midnight-ntwrk/midnight-js-utils';
import { CURRENT_LEDGER_ERA } from '@midnight-ntwrk/midnight-js-protocol/version';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { PROVIDER_IMPORTS, generateCallScript, generateDeployScript, pricingProofProviderCode, providerSetupCode as providerSetupCodeFor, walletProviderCode } from '../contract-scripts.ts';

/** The script parts, as plain values: the fragments under test read only the indexer's environment variable names. */
const TEST_PARTS: ScriptParts = {
  prelude: '',
  rpcClientCode: () => '',
  coerceArgFn: '',
  privateStateSecretFn: '',
  // The store opener is the contract runner's (tested there): here it keeps the wallet's own account.
  privateStateStoreFn: 'const openPrivateStateStore = async (_deps, options) => ({ accountId: options.accountId });',
  privateStateSecretEnv: 'MN_TEST_PRIVATE_STATE_SECRET',
  privateStatePasswordEnv: 'MN_TEST_PRIVATE_STATE_PASSWORD',
  privateStateAccountEnv: 'MN_TEST_PRIVATE_STATE_ACCOUNT',
  privateStateDirEnv: 'MN_TEST_PRIVATE_STATE_DIR',
  // The wait for a busy store is the contract runner's (tested there): here the provider as it is.
  privateStateWaitFn: 'const waitForPrivateState = (provider) => provider; const privateStateBusyText = () => "";',
  privateStateName: (address) => `contract ${address}`,
  privateStateBusyWaitMs: 1_000,
  noticeMarker: '__MN_TEST_NOTICE__',
  pricedMarker: '__MN_TEST_PRICED__',
  dryRunEnv: 'MN_TEST_DRY_RUN',
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
    'rpcCall', 'createLedger9WalletProvider', 'createLedger9MidnightProvider', 'Transaction', 'toHex', 'fromHex',
    `${walletProviderCode()}\nreturn { walletProvider, midnightProvider };`,
  );
  return await fn(rpcCall, createLedger9WalletProvider, createLedger9MidnightProvider, ledger.Transaction, toHex, fromHex) as {
    walletProvider: WalletProvider;
    midnightProvider: MidnightProvider;
  };
}

// Real ledger-v9 txs built offline: an empty intent needs no circuit proofs,
// so prove() never reaches the proving provider. midnight-js hands providers
// each as a handle: its bytes tagged with the ledger era.
let unboundTx: ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;
let finalizedTx: ledger.FinalizedTransaction;
const unboundHandle = () => LedgerTransaction.seal('v9', 'Unbound', unboundTx);
const finalizedHandle = () => LedgerTransaction.seal('v9', 'Finalized', finalizedTx);

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

    expect(walletProvider.supportedEras).toContain(CURRENT_LEDGER_ERA);
    expect(midnightProvider.supportedEras).toContain(CURRENT_LEDGER_ERA);
  });

  it('returns the keys mn serve reports', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    expect(walletProvider.getCoinPublicKey()).toBe(COIN_PK);
    expect(walletProvider.getEncryptionPublicKey()).toBe(ENC_PK);
  });

  it('balances a v9 tx via balanceUnsealedTransaction and returns the balanced tx as a v9 handle', async () => {
    const sealedHex = toHex(finalizedTx.serialize());
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      balanceUnsealedTransaction: { tx: sealedHex },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    const balanced = await walletProvider.balanceTx(unboundHandle());

    const balanceCall = calls.find((c) => c.method === 'balanceUnsealedTransaction');
    expect(balanceCall?.params).toEqual({ tx: toHex(unboundTx.serialize()) });
    expect(balanced.era).toBe('v9');
    expect(balanced.stage).toBe('Finalized');
    expect(toHex(balanced.serialize())).toBe(sealedHex);
  });

  it('surfaces an RPC rejection from mn serve', async () => {
    const { rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
    });
    const { walletProvider } = await evalWalletProviders(rpcCall);

    await expect(walletProvider.balanceTx(unboundHandle()))
      .rejects.toThrow('unexpected RPC balanceUnsealedTransaction');
  });
});

describe('generated midnightProvider', () => {
  it('submits the tx hex via submitTransaction and returns its first identifier', async () => {
    const { calls, rpcCall } = makeRpcStub({
      getShieldedAddresses: { shieldedCoinPublicKey: COIN_PK, shieldedEncryptionPublicKey: ENC_PK },
      submitTransaction: { txHash: 'ignored-by-provider' },
    });
    const { midnightProvider } = await evalWalletProviders(rpcCall);

    const txId = await midnightProvider.submitTx(finalizedHandle());

    const submitCall = calls.find((c) => c.method === 'submitTransaction');
    expect(submitCall?.params).toEqual({ tx: toHex(finalizedTx.serialize()) });
    expect(txId).toBe(finalizedTx.identifiers()[0]);
  });
});

describe('generated pricing proof provider', () => {
  /** What the script's process would do: its environment, the lines it writes to stderr, and an exit, which ends the proof here. */
  class Exited extends Error {
    constructor(readonly code: number) { super(`exited ${code}`); }
  }
  const scriptProcess = (env: Record<string, string>) => {
    const stderr: string[] = [];
    return { stderr, process: { env, stderr: { write: (text: string) => { stderr.push(text); return true; } }, exit: (code: number) => { throw new Exited(code); } } };
  };
  /** The price mn serve answers with, as it crosses JSON-RPC. */
  const PRICE = { committed: '1234000000000000', have: '5000000000000000', covers: true, waitMs: 0, marginBlocks: 3 };
  /** midnight-js's proof provider at the SDK's boundary: says what it was handed to prove. */
  const proving = () => {
    const proved: unknown[] = [];
    return { proved, provider: { supportedEras: ['v9'], proveTx: async (tx: unknown) => { proved.push(tx); return 'proven'; } } };
  };
  const unprovenHandle = () => LedgerTransaction.seal('v9', 'Unproven', ledger.Transaction.fromParts(
    'undeployed', undefined, undefined, ledger.Intent.new(new Date(Date.UTC(2030, 0, 1))),
  ));

  /** The fragment, evaluated with the script's bindings: mn serve's RPC, the prelude's fail, and the process given. */
  async function evalPricing(rpcCall: unknown, process: unknown, failed: unknown[] = [], globals: Record<string, unknown> = {}) {
    const fn = new AsyncFunction(
      'rpcCall', 'rpcClose', 'toHex', 'fail', 'process', 'globalThis',
      `${pricingProofProviderCode(TEST_PARTS)}\nreturn pricingProofProvider;`,
    );
    const fail = (err: unknown) => { failed.push(err); throw new Exited(1); };
    return await fn(rpcCall, () => {}, toHex, fail, process, globals) as (proving: unknown) => { supportedEras: readonly string[]; proveTx(tx: unknown): Promise<unknown> };
  }

  it('prices the transaction it is handed through mn serve, says the price on its marked line, then proves it', async () => {
    const { calls, rpcCall } = makeRpcStub({ [PRICE_TRANSACTION_METHOD]: PRICE });
    const { stderr, process } = scriptProcess({});
    const { proved, provider } = proving();
    const pricing = (await evalPricing(rpcCall, process))(provider);
    const tx = unprovenHandle();

    expect(pricing.supportedEras).toEqual(['v9']);
    expect(await pricing.proveTx(tx)).toBe('proven');
    expect(calls).toEqual([{ method: PRICE_TRANSACTION_METHOD, params: { tx: toHex(tx.serialize()) } }]);
    expect(stderr.join('')).toBe(`\n__MN_TEST_PRICED__ ${JSON.stringify(PRICE)}\n`);
    expect(proved).toEqual([tx]);
  });

  it('stops once priced on a dry run: nothing is proven', async () => {
    const { rpcCall } = makeRpcStub({ [PRICE_TRANSACTION_METHOD]: PRICE });
    const { stderr, process } = scriptProcess({ MN_TEST_DRY_RUN: '1' });
    const { proved, provider } = proving();
    const pricing = (await evalPricing(rpcCall, process))(provider);

    const stopped = await pricing.proveTx(unprovenHandle()).catch((e: unknown) => e);
    expect(stopped).toEqual(new Exited(0));
    expect(stderr.join('')).toContain(`__MN_TEST_PRICED__ ${JSON.stringify(PRICE)}`);
    expect(proved).toEqual([]);
  });

  it('proves as before when mn serve gives no price, saying so', async () => {
    // An mn serve from before the price: the method is unknown to it.
    const { rpcCall } = makeRpcStub({});
    const { stderr, process } = scriptProcess({});
    const { proved, provider } = proving();
    // The RPC client keeps mn serve's last refusal for the prelude to report; this one refused no transaction.
    const globals: Record<string, unknown> = { mnServeRefusal: new Error('the price refused') };
    const pricing = (await evalPricing(rpcCall, process, [], globals))(provider);

    expect(await pricing.proveTx(unprovenHandle())).toBe('proven');
    expect(globals.mnServeRefusal).toBeUndefined();
    expect(stderr.join('')).toBe(`Could not price the transaction before proving it: unexpected RPC ${PRICE_TRANSACTION_METHOD}\n`);
    expect(proved).toHaveLength(1);
  });

  it('fails a dry run whose price mn serve refuses, with mn serve\'s failure', async () => {
    const { rpcCall } = makeRpcStub({});
    const { process } = scriptProcess({ MN_TEST_DRY_RUN: '1' });
    const { proved, provider } = proving();
    const failed: unknown[] = [];
    const pricing = (await evalPricing(rpcCall, process, failed))(provider);

    expect(await pricing.proveTx(unprovenHandle()).catch((e: unknown) => e)).toEqual(new Exited(1));
    expect(failed).toEqual([new Error(`unexpected RPC ${PRICE_TRANSACTION_METHOD}`)]);
    expect(proved).toEqual([]);
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
      'NodeZkConfigProvider', 'httpClientProofProvider', 'indexerPublicDataProvider', 'levelPrivateStateProvider', 'mnFs', 'mnPath',
      `${providerSetupCode(NETWORK, 'counterPrivateState')}\nreturn providers;`,
    );
    // The generated code reads the indexer's URLs and the private-state store's password and account from its environment, as the script's process is given them.
    const environment = {
      ...indexerEnvironment(NETWORK),
      [TEST_PARTS.privateStatePasswordEnv]: 'Mn-abc-def-123-456',
      [TEST_PARTS.privateStateAccountEnv]: 'mn-test-account',
      [TEST_PARTS.privateStateDirEnv]: join(dir, 'private-state'),
    };
    Object.assign(process.env, environment);
    try {
      const providers = await fn(
        dir, walletProvider, midnightProvider,
        NodeZkConfigProvider, httpClientProofProvider, indexerPublicDataProvider, levelPrivateStateProvider, fs, path,
      );
      try {
        expect(() => assertProvidersSupportEra(CURRENT_LEDGER_ERA, providers)).not.toThrow();
        expect(providers.midnightProvider).toBe(midnightProvider);
        expect(providers.config).toEqual({ networkId: 'undeployed', ttlSeconds: 3600 });
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

  it('imports no midnight-js-network-id, which midnight-js 5 removed: the providers carry the network', () => {
    expect(scripts.deploy).not.toContain('midnight-js-network-id');
    expect(scripts.call).not.toContain('midnight-js-network-id');
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
