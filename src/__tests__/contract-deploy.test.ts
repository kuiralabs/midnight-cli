// Deploying a contract checks first that the paying wallet can pay: a wallet
// that isn't there stops the deploy before anything is served. The home and
// the compiled contract are temporary; nothing reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { resolveContractDeployRequest } from '../lib/contract/request.ts';
import { deployContract } from '../lib/contract/deploy.ts';
import { resolvePayingTarget } from '../lib/payer.ts';
import { servePayerAt } from '../lib/serve-payer.ts';
import { setProgressTarget, silentSpinner } from '../ui/spinner.ts';

const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-contract-deploy-')));
  process.env.HOME = home;
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
    const args = parseArgs(['contract', 'deploy', '--path', path.join(home, 'dapp'), '--wallet', 'nobody', ...ENDPOINTS]);
    const said: string[] = [];
    setProgressTarget((message) => said.push(message));
    try {
      await expect(deployContract({
        request: resolveContractDeployRequest(args),
        target: resolvePayingTarget(args, 'contract', 'deploy'),
        wallet: 'nobody',
        // Never reached: serving would be the step after the funds check.
        payer: servePayerAt(1),
        progress: (message) => { said.push(message); return silentSpinner(); },
      })).rejects.toThrow(path.join(home, '.midnight', 'wallets', 'nobody.json'));
    } finally {
      setProgressTarget(null);
    }
    expect(said).toEqual(['Checking wallet...']);
  });
});
