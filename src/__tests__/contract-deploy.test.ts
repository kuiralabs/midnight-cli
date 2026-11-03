// Deploying a contract checks first that the paying wallet can pay: a wallet
// that isn't there stops the deploy before anything is served. The home and
// the compiled contract are temporary; nothing reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { contractDeployRequest } from '../lib/contract/request.ts';
import { deployContract } from '../lib/contract/deploy.ts';
import { servePayerAt } from '../lib/serve-payer.ts';
import { createSdkWarningRouter } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { CancelledError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { stateRootIn } from './helpers/state-root-in.ts';
import { createHost, type Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { loadInstalledEngine } from '../lib/installed-engines.ts';

const ENDPOINTS = { network: 'undeployed' as const, node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws', proofServer: 'http://localhost:26300' };
// The host the tests' calls run in: its state root under the test's home, the engines the CLI ships, nobody to ask, notices dropped.
let host: Host;

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-contract-deploy-')));
  process.env.HOME = home;
  host = createHost({ paths: { stateRoot: stateRootIn(home), home }, engineLoader: loadInstalledEngine });
  const compiler = path.join(home, 'dapp', 'managed', 'counter', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': '0.20.0',
    circuits: [{ name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('deployContract', () => {
  it('stops at the funds check when the paying wallet is not there, before anything is served', async () => {
    const said: string[] = [];
    await expect(deployContract(host, {
      ...ENDPOINTS,
      request: contractDeployRequest({ dappDir: path.join(home, 'dapp') }),
      wallet: 'nobody',
      // Never reached: serving would be the step after the funds check.
      payer: servePayerAt(1),
      onProgress: (event) => { if ('message' in event) said.push(event.message); },
      sdkWarnings: createSdkWarningRouter().openCall().warnings,
    })).rejects.toThrow(path.join(home, '.midnight', 'wallets', 'nobody.json'));
    expect(said).toEqual(['Checking wallet...']);
  });

  it("asks the payer it is given whether it can pay, not mn's own wallets", async () => {
    // A program's own payer, paying from a wallet mn has no file for (the injection the Payer interface exists for).
    const asked: string[] = [];
    const ownPayer = {
      assertCanPay: async (_target: unknown, wallet: string | undefined) => { asked.push(`assertCanPay ${wallet}`); return { nightBalance: 1n, dustBalance: 1n }; },
      serve: async () => { asked.push('serve'); throw new Error('served by the program'); },
      connect: async () => { throw new Error('not used'); },
    };
    await expect(deployContract(host, {
      ...ENDPOINTS,
      request: contractDeployRequest({ dappDir: path.join(home, 'dapp') }),
      wallet: 'external',
      payer: ownPayer,
      sdkWarnings: createSdkWarningRouter().openCall().warnings,
    })).rejects.toThrow('served by the program');
    expect(asked).toEqual(['assertCanPay external', 'serve']);
    expect(fs.existsSync(path.join(home, '.midnight', 'wallets'))).toBe(false);
  });

  it('hands the payer the call\'s cancellation, and serves nothing once the call is cancelled during the funds check', async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    const ownPayer = {
      assertCanPay: async (_target: unknown, _wallet: string | undefined, _progress: unknown, signal: AbortSignal | undefined) => {
        asked.push(`assertCanPay ${signal === controller.signal ? 'with the call\'s signal' : 'without it'}`);
        controller.abort(); // the user cancels while the wallet is checked
        return { nightBalance: 1n, dustBalance: 1n };
      },
      serve: async () => { asked.push('serve'); throw new Error('must not be served'); },
      connect: async () => { throw new Error('not used'); },
    };
    await expect(deployContract(host, {
      ...ENDPOINTS,
      request: contractDeployRequest({ dappDir: path.join(home, 'dapp') }),
      wallet: 'external',
      payer: ownPayer,
      sdkWarnings: createSdkWarningRouter().openCall().warnings,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(CancelledError);
    expect(asked).toEqual(['assertCanPay with the call\'s signal']);
  });
});
