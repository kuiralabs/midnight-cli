// The commands that wait on the network stop when their call is cancelled
// while they wait, instead of waiting out their own time limits. Every
// endpoint is a stand-in run by the test that takes each request and never
// answers; the call is cancelled as the first request arrives, and must answer
// CANCELLED well inside the shortest time limit it would otherwise wait out
// (5 s). Nothing here reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { parseArgs, type CommandHandler } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';
import { establishPassphrase, createWallet, walletSecretFrom } from '@kuiralabs/midnight-wallet';
import { servePayerAt } from '../lib/serve-payer.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';
import { declaredOutcome } from './helpers/expect-declared.ts';
import { stateRootIn } from '../../test-support/state-root-in.ts';
import { testHost } from '../../test-support/test-host.ts';

const PASSPHRASE = 'correct horse battery staple';
const ACCOUNT = '5e'.repeat(32);

let home: string;
let io: CapturedOutput;
let server: Server;
let sockets: Socket[];
let onFirstRequest: () => void;
let requests: number;
let freePort: number;
const originalHome = process.env.HOME;
const originalPassphrase = process.env.MN_PASSPHRASE;

beforeEach(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-network-cancel-')));
  process.env.HOME = home;
  process.env.MN_PASSPHRASE = PASSPHRASE;
  establishPassphrase(stateRootIn(home), PASSPHRASE);
  const { engines } = testHost();
  await createWallet(stateRootIn(home), 'alice', walletSecretFrom(), PASSPHRASE, await engines.any());
  await createWallet(stateRootIn(home), 'bob', walletSecretFrom(), PASSPHRASE, await engines.any());
  io = captureOutput();
  // Every endpoint: takes HTTP requests and WebSocket upgrades, and answers none.
  requests = 0;
  sockets = [];
  onFirstRequest = () => {};
  const took = (): void => { requests += 1; if (requests === 1) onFirstRequest(); };
  server = createServer(() => took());
  server.on('upgrade', (_req, socket: Socket) => { sockets.push(socket); took(); });
  server.on('connection', (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A port nothing listens on, for serve to take.
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  freePort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterEach(async () => {
  io.restore();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.HOME = originalHome;
  if (originalPassphrase === undefined) delete process.env.MN_PASSPHRASE;
  else process.env.MN_PASSPHRASE = originalPassphrase;
  fs.rmSync(home, { recursive: true, force: true });
});

const endpoints = (): string[] => {
  const { port } = server.address() as AddressInfo;
  return ['--network', 'undeployed', '--node', `ws://127.0.0.1:${port}`, '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--proof-server', `http://127.0.0.1:${port}`];
};

function dapp(): string {
  const dir = path.join(home, 'dapp');
  const compiler = path.join(dir, 'managed', 'counter', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
    'compiler-version': '0.35.0', 'language-version': '0.27.0', 'runtime-version': '0.20.0',
    circuits: [{ name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
    witnesses: [],
  }));
  return dir;
}

function accountForAlice(): void {
  const records = path.join(stateRootIn(home), 'accounts', 'undeployed', 'alice');
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(records, 'owner.json'), JSON.stringify({ contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) }), { mode: 0o600 });
}

const cases: Array<[string, () => string[]]> = [
  ['transfer', () => ['transfer', 'bob', '1', '--wallet', 'alice', '--json']],
  ['shielded transfer', () => ['transfer', 'bob', '1', '--shielded', '--wallet', 'alice', '--json']],
  ['airdrop', () => ['airdrop', '10', '--wallet', 'alice', '--json']],
  ['dust register', () => ['dust', 'register', '--wallet', 'alice', '--json']],
  ['dust status', () => ['dust', 'status', '--wallet', 'alice', '--json']],
  ['contract deploy', () => ['contract', 'deploy', '--path', dapp(), '--wallet', 'alice', '--json']],
  ['contract call', () => ['contract', 'call', '--circuit', 'increment', '--address', 'ab'.repeat(32), '--path', dapp(), '--wallet', 'alice', '--json']],
  ['contract state', () => ['contract', 'state', '--address', 'ab'.repeat(32), '--path', dapp(), '--json']],
  ['grant deposit', () => { accountForAlice(); return ['grant', 'deposit', '1', '--wallet', 'alice', '--json']; }],
  ['serve', () => ['serve', '--wallet', 'alice', '--port', String(freePort), '--json']],
];

describe('cancelled while the network has not answered', () => {
  it.each(cases)('%s: CANCELLED, well before its own time limit', async (_name, argv) => {
    const args = parseArgs([...argv(), ...endpoints()]);
    const { default: handler } = await installedCommands.find(args.command!)!.load();
    const call = new AbortController();
    let cancelledAt = 0;
    onFirstRequest = () => { cancelledAt = Date.now(); call.abort(); };

    const outcome = await declaredOutcome(args.command!, cliCall(handler as CommandHandler, args, { signal: call.signal, payer: servePayerAt(0) })).then(() => 'finished', (err: unknown) => err);

    expect(requests, `it reached the network: ${String(outcome instanceof Error ? outcome.message : outcome)}`).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ code: 'CANCELLED' });
    expect(Date.now() - cancelledAt).toBeLessThan(4_000);
    expect(io.stdout()).toBe('');
  }, 30_000);
});
