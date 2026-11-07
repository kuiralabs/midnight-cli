// deployContract, callContract and readContractState, called as a program
// calls them: a host of its own (a temporary state root, the engines the CLI
// ships), plain values in, typed results and codes out, no argv and no call
// context. The payer is the program's own (the injection the Payer interface
// exists for); the indexer a contract's raw state is read from is a stand-in
// HTTP endpoint (local-indexer.ts). A deploy or call that reaches a chain
// needs one: the scratch chain's live runs cover them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, type Host, type Payer, type PayingTarget, InsufficientBalanceError } from '@kuiralabs/midnight-cli-core';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { contractCallRequest, contractDeployRequest } from '../lib/contract/request.ts';
import { deployContract } from '../lib/contract/deploy.ts';
import { callContract } from '../lib/contract/call.ts';
import { readContractState } from '../lib/contract/state.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

const ADDRESS = 'cb5230e1ac98e07520d3b330016743a05fec38dd8fe894ae5b9ac3f71cac5190';
const ENDPOINTS = { network: 'undeployed' as const, node: 'ws://127.0.0.1:29944', indexerWS: 'ws://127.0.0.1:28088/api/v4/graphql/ws', proofServer: 'http://127.0.0.1:26300' };

let home: string;
let dapp: string;
let host: Host;

/** A compiled contract as compactc lays it out, for compact-runtime `runtimeVersion`. */
function compiledContract(runtimeVersion: string): void {
  const compiler = path.join(dapp, 'managed', 'counter', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.36.0', 'language-version': '0.28.0', 'runtime-version': runtimeVersion,
    circuits: [{ name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-contract-lib-')));
  dapp = path.join(home, 'dapp');
  host = createHost({ paths: { stateRoot: path.join(home, '.midnight'), home }, engineLoader: loadInstalledEngine });
  compiledContract('0.21.0');
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

/** A program's payer that records what it is asked: its wallet has `night` NIGHT, and serving fails as `serveFails` says. */
function programPayer(night: bigint, serveFails = 'served by the program') {
  const asked: { step: string; target: PayingTarget; wallet: string | undefined; signal: AbortSignal | undefined }[] = [];
  const payer: Payer = {
    assertCanPay: async (target, wallet, progress, signal) => {
      asked.push({ step: 'assertCanPay', target, wallet, signal });
      progress.update('Reading the balance...');
      if (night === 0n) {
        progress.fail('No NIGHT balance');
        throw new InsufficientBalanceError('Wallet has 0 NIGHT');
      }
      progress.stop('Wallet OK');
      return { nightBalance: night, dustBalance: 1n };
    },
    serve: async (target, wallet, _progress, _sdkWarnings, signal) => {
      asked.push({ step: 'serve', target, wallet, signal });
      throw new Error(serveFails);
    },
    connect: async () => { throw new Error('not used'); },
  };
  return { payer, asked };
}

describe('deployContract', () => {
  it('says the contract suits the network, then each payer step; a failed step says so, and the payer\'s code comes out', async () => {
    const { payer, asked } = programPayer(0n);
    const said: unknown[] = [];
    await expect(deployContract(host, { ...ENDPOINTS, request: contractDeployRequest({ dappDir: dapp }), payer, wallet: 'alice', onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(said).toEqual([
      { kind: 'contract-checked', network: 'undeployed' },
      { kind: 'start', message: 'Checking wallet...' },
      { kind: 'update', message: 'Reading the balance...' },
      { kind: 'step-failed', message: 'No NIGHT balance' },
    ]);
    expect(asked.map(({ step, wallet }) => [step, wallet])).toEqual([['assertCanPay', 'alice']]);
    // The payer pays on the network and endpoints the call chose.
    expect(asked[0]!.target).toMatchObject({ network: 'undeployed', root: path.join(home, '.midnight'), endpoints: { node: ENDPOINTS.node, indexerWS: ENDPOINTS.indexerWS, proofServer: ENDPOINTS.proofServer } });
    expect(asked[0]!.target.networkConfig.node).toBe(ENDPOINTS.node);
  });

  it('ends the wallet check\'s step with its words and starts serving, which fails as the payer says', async () => {
    const { payer, asked } = programPayer(5n);
    const said: unknown[] = [];
    await expect(deployContract(host, { ...ENDPOINTS, request: contractDeployRequest({ dappDir: dapp }), payer, onProgress: (event) => said.push(event) }))
      .rejects.toThrow('served by the program');
    expect(said).toEqual([
      { kind: 'contract-checked', network: 'undeployed' },
      { kind: 'start', message: 'Checking wallet...' },
      { kind: 'update', message: 'Reading the balance...' },
      { kind: 'done', message: 'Wallet OK' },
      { kind: 'start', message: 'Starting mn serve...' },
    ]);
    // No wallet given: the payer pays from its active one.
    expect(asked.map(({ step, wallet }) => [step, wallet])).toEqual([['assertCanPay', undefined], ['serve', undefined]]);
  });

  it('refuses a contract compiled for another runtime with INVALID_ARGS, before the payer is asked or anything said', async () => {
    compiledContract('0.16.0');
    const { payer, asked } = programPayer(5n);
    const said: unknown[] = [];
    await expect(deployContract(host, { ...ENDPOINTS, request: contractDeployRequest({ dappDir: dapp }), payer, onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('compiled by compactc 0.36.0 for compact-runtime 0.16.0') });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  it('refuses a network that is not one, before the payer is asked', async () => {
    const { payer, asked } = programPayer(5n);
    await expect(deployContract(host, { ...ENDPOINTS, network: 'moonnet' as never, request: contractDeployRequest({ dappDir: dapp }), payer })).rejects.toThrow('Invalid network: "moonnet"');
    expect(asked).toEqual([]);
  });

  it('cancelled already: CancelledError, and nothing asked of the payer or said', async () => {
    const { payer, asked } = programPayer(5n);
    const said: unknown[] = [];
    await expect(deployContract(host, { ...ENDPOINTS, request: contractDeployRequest({ dappDir: dapp }), payer, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('callContract', () => {
  const request = () => contractCallRequest({ dappDir: dapp, address: ADDRESS, circuit: 'increment' });

  it('says the contract suits the network and checks the payer\'s wallet, handing it the call\'s wallet and cancellation', async () => {
    const { payer, asked } = programPayer(0n);
    const controller = new AbortController();
    const said: unknown[] = [];
    await expect(callContract(host, { ...ENDPOINTS, request: request(), payer, wallet: 'bob', signal: controller.signal, onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(said[0]).toEqual({ kind: 'contract-checked', network: 'undeployed' });
    expect(said.at(-1)).toEqual({ kind: 'step-failed', message: 'No NIGHT balance' });
    expect(asked.map(({ step, wallet, signal }) => [step, wallet, signal === controller.signal])).toEqual([['assertCanPay', 'bob', true]]);
  });

  it('refuses a contract compiled for another runtime with INVALID_ARGS, before the payer is asked', async () => {
    compiledContract('0.16.0');
    const { payer, asked } = programPayer(5n);
    await expect(callContract(host, { ...ENDPOINTS, request: request(), payer })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(asked).toEqual([]);
  });

  it('cancelled already: CancelledError, and nothing asked of the payer or said', async () => {
    const { payer, asked } = programPayer(5n);
    const said: unknown[] = [];
    await expect(callContract(host, { ...ENDPOINTS, request: request(), payer, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('readContractState', () => {
  let indexer: LocalIndexer;
  // An indexer that holds no contract at any address.
  beforeEach(async () => { indexer = await startLocalIndexer(() => JSON.stringify({ data: { contract: null, block: null } })); });
  afterEach(() => indexer.close());

  const at = () => ({ ...ENDPOINTS, indexerWS: indexer.url.replace('http', 'ws') + '/ws' });

  it('without a compiled contract in the dApp, falls back to the raw state after saying why; no contract at the address fails', async () => {
    const said: unknown[] = [];
    const empty = path.join(home, 'empty');
    fs.mkdirSync(empty);
    await expect(readContractState(host, { ...at(), dappDir: empty, address: ADDRESS, onProgress: (event) => said.push(event) }))
      .rejects.toThrow(`No contract found at address ${ADDRESS} on undeployed`);
    expect(said).toEqual([
      { kind: 'state-reading', network: 'undeployed' },
      { kind: 'start', message: 'Querying contract state...' },
      { kind: 'fallback', reason: expect.stringContaining(`No compiled contract found in ${empty}`) },
    ]);
    // The reachability check's one small query, then the state's.
    expect(indexer.requests).toHaveLength(2);
    expect(indexer.requests[0]).toEqual({ query: '{ __typename }' });
    expect(indexer.requests[1]!.variables).toMatchObject({ address: ADDRESS });
  });

  it('fails at once with NETWORK_ERROR naming an indexer that is down, without falling back', async () => {
    const port = await closedPort();
    const said: unknown[] = [];
    await expect(readContractState(host, { ...at(), indexerWS: `ws://127.0.0.1:${port}/api/v4/graphql/ws`, dappDir: dapp, address: ADDRESS, onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the indexer at http://127.0.0.1:${port}/api/v4/graphql: connection refused.`) });
    expect(said.some((event) => (event as { kind: string }).kind === 'fallback')).toBe(false);
  });

  it('refuses an address that is not 64 hex characters with INVALID_ARGS, saying nothing and asking no indexer', async () => {
    const said: unknown[] = [];
    await expect(readContractState(host, { ...at(), dappDir: dapp, address: 'deadbeef', onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    expect(said).toEqual([]);
    expect(indexer.requests).toEqual([]);
  });

  it('cancelled already: CancelledError, nothing said and no indexer asked', async () => {
    const said: unknown[] = [];
    await expect(readContractState(host, { ...at(), dappDir: dapp, address: ADDRESS, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said).toEqual([]);
    expect(indexer.requests).toEqual([]);
  });
});
