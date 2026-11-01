// A command that pays is given its payer by its caller. Without one it
// refuses before it touches a wallet; a command that pays nothing never asks
// for one. The serve payer reuses a running mn serve and leaves it running.
// The home directory is a temporary one; nothing here reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { saveCliConfig } from '../lib/cli-config.ts';
import { NoPayerError, resolvePayingTarget } from '../lib/payer.ts';
import { NoAccountError } from '../lib/grant/prepare.ts';
import { servePayerAt } from '../lib/serve-payer.ts';
import { probeServeNetwork } from '../lib/serve-manager.ts';
import { silentSpinner } from '../ui/spinner.ts';
import { createSdkWarningRouter } from '../lib/sdk-warnings.ts';
import { CancelledError } from '../lib/errors.ts';
import { assertWalletCanPay } from '../lib/wallet-can-pay.ts';
import contractCommand from '../commands/contract.ts';
import grantCommand from '../commands/grant.ts';
import { cliCall } from './helpers/cli-call.ts';

const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];

let home: string;
let origHome: string | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-payer-home-')));
  origHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('resolvePayingTarget', () => {
  it('acts on undeployed when no network is given, with the endpoints given as flags', () => {
    const target = resolvePayingTarget(parseArgs(['contract', 'deploy', ...ENDPOINTS]), 'contract', 'deploy');
    expect(target.network).toBe('undeployed');
    expect(target.endpoints).toEqual({ node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws', proofServer: 'http://localhost:26300' });
    expect(target.networkConfig.node).toBe('ws://localhost:29944');
    expect(target.networkConfig.indexer).toBe('http://localhost:28088/api/v4/graphql');
    expect(target.networkConfig.proofServer).toBe('http://localhost:26300');
  });

  it('acts on the network set with config set network when none is given, as every other command does', () => {
    saveCliConfig({ network: 'preprod' });
    expect(resolvePayingTarget(parseArgs(['contract', 'deploy']), 'contract', 'deploy').network).toBe('preprod');
    expect(resolvePayingTarget(parseArgs(['contract', 'deploy', '--network', 'preview']), 'contract', 'deploy').network).toBe('preview');
  });
});

describe('a command called without a payer', () => {
  it.each(['deploy', 'call'])('contract %s refuses, naming itself', async (subcommand) => {
    const refused = cliCall(contractCommand, parseArgs(['contract', subcommand, ...ENDPOINTS]));
    await expect(refused).rejects.toThrow(NoPayerError);
    await expect(refused).rejects.toThrow(`contract ${subcommand} submits a transaction, but its caller gave it no payer to pay with.`);
  });

  it('contract inspect reads local files and asks for no payer', async () => {
    await expect(cliCall(contractCommand, parseArgs(['contract', 'inspect', '--path', home]))).rejects.toThrow(`No compiled contract found in ${home}`);
  });

  it('grant deploy refuses before it opens the wallet', async () => {
    fs.mkdirSync(path.join(home, '.midnight', 'wallets'), { recursive: true });
    // A wallet file that can't be unlocked: reaching the wallet would fail differently.
    fs.writeFileSync(path.join(home, '.midnight', 'wallets', 'alice.json'), '{}');
    await expect(cliCall(grantCommand, parseArgs(['grant', 'deploy', '--wallet', 'alice', '--json', ...ENDPOINTS]))).rejects.toThrow(NoPayerError);
  });

  it('grant status pays nothing and asks for no payer', async () => {
    await expect(cliCall(grantCommand, parseArgs(['grant', 'status', '--wallet', 'alice', '--json', ...ENDPOINTS]))).rejects.toThrow(NoAccountError);
  });
});

describe('the serve payer', () => {
  // A running `mn serve`: a real JSON-RPC WebSocket server answering the
  // probes the reuse check makes, for the requested chain.
  async function runningServe() {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      const result = req.method === 'getConnectionStatus' ? { status: 'connected', networkId: 'undeployed' }
        : req.method === 'getConfiguration' ? { substrateNodeUri: 'ws://localhost:29944', indexerWsUri: 'ws://localhost:28088/api/v4/graphql/ws' }
        : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    }));
    const port = (wss.address() as import('node:net').AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => wss.close(() => r())) };
  }

  it('serves the wallet through a running mn serve, and leaves it running when stopped', async () => {
    const serve = await runningServe();
    const said: string[] = [];
    try {
      const target = resolvePayingTarget(parseArgs(['contract', 'deploy', ...ENDPOINTS]), 'contract', 'deploy');
      const served = await servePayerAt(serve.port).serve(target, undefined, silentSpinner((message) => said.push(message)), createSdkWarningRouter().openCall().warnings, undefined);
      expect(served.port).toBe(serve.port);
      expect(said).toEqual([`Reusing existing mn serve on port ${serve.port}`, `mn serve ready (port ${serve.port})`]);
      await served.stop();
      expect(await probeServeNetwork(serve.port)).toBe('undeployed');
    } finally {
      await serve.close();
    }
  });

  it('serves nothing for a call already cancelled, not even probing the running serve', async () => {
    const serve = await runningServe();
    const said: string[] = [];
    try {
      const target = resolvePayingTarget(parseArgs(['contract', 'deploy', ...ENDPOINTS]), 'contract', 'deploy');
      const controller = new AbortController();
      controller.abort();
      await expect(servePayerAt(serve.port).serve(target, undefined, silentSpinner((message) => said.push(message)), createSdkWarningRouter().openCall().warnings, controller.signal)).rejects.toBeInstanceOf(CancelledError);
      expect(said).toEqual([]);
    } finally {
      await serve.close();
    }
  });

  it('checks no wallet for a call already cancelled', async () => {
    const target = resolvePayingTarget(parseArgs(['contract', 'deploy', ...ENDPOINTS]), 'contract', 'deploy');
    const controller = new AbortController();
    controller.abort();
    // Not cancelled, this would fail on the missing wallet file.
    await expect(assertWalletCanPay(target, 'nobody', silentSpinner(), controller.signal)).rejects.toBeInstanceOf(CancelledError);
  });
});
