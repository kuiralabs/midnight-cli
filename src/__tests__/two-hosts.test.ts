// Two hosts in one process, each with its own state root and its own
// settings, run real commands through the registry's dispatch, as the shell
// does: each generates a wallet sealed under its own passphrase (given as its
// host's MN_PASSPHRASE, never the process's), sets and reads its own config,
// lists its own wallets and its own open swap offers. Nothing of one shows in
// the other, nothing lands in the process's home, and no setting is read from
// the process's environment.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createHost, type Host, parseArgs, MIDNIGHT_DIR, settingsFromEnvironment, recordOpenOffer, type OpenOffer, type CallOutput } from '@kuiralabs/midnight-cli-core';
import { dispatchCommand } from '../lib/command-dispatch.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { checkPassphrase } from '../lib/passphrase.ts';

const PASSPHRASE_A = 'host A passphrase, twelve or more';
const PASSPHRASE_B = 'host B passphrase, twelve or more';
// Set in the process's environment while the hosts run: neither may take it.
const PROCESS_PASSPHRASE = 'the process environment passphrase';

/** An open offer of the wallet's, recorded as `swap make` records one. */
const offer = (id: string, nullifier: string): OpenOffer => ({
  id: id.repeat(32),
  terms: { give: { token: '00'.repeat(31) + '01', amount: 10n }, want: { token: '00'.repeat(31) + '02', amount: 7n } },
  nullifiers: [nullifier.repeat(32)],
  madeAt: new Date('2026-11-02T10:00:00.000Z'),
  expiresAt: new Date('2100-01-01T00:00:00.000Z'),
});

/**
 * An indexer standing in for the chain's, on one port as a real one is: its
 * GraphQL endpoint answers the tip query, and its WebSocket answers each
 * spend check with no spends. Records the nullifiers each check asks about.
 */
async function startSpendIndexer(): Promise<{ wsUrl: string; asked: string[][]; close: () => Promise<void> }> {
  const asked: string[][] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { block: { height: 812 } } }));
    });
  });
  const wss = new WebSocketServer({ server, path: '/api/v4/graphql/ws' });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString()) as { type: string; id?: string; payload?: { variables?: { prefixes?: string[] } } };
    if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
    else if (msg.type === 'subscribe') {
      asked.push(msg.payload?.variables?.prefixes ?? []);
      ws.send(JSON.stringify({ id: msg.id, type: 'complete' }));
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
    asked,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let base: string;
let processHome: string;
let originalHome: string | undefined;
let originalEnv: NodeJS.ProcessEnv;
// The settings and the home the process's environment was asked for while the hosts ran.
let envReads: string[];

/** A host of its own: its state root under `home`, its settings as values (no local stack detection: docker's containers must not matter), and an engine of its own. */
function hostAt(home: string, passphrase: string): Host {
  return createHost({
    paths: { stateRoot: path.join(home, MIDNIGHT_DIR), home },
    settings: settingsFromEnvironment({ MN_PASSPHRASE: passphrase, MN_NO_LOCAL_DETECT: '1' }),
    engineLoader: loadInstalledEngine,
  });
}

/** Runs `argv` with --json through the registry's dispatch in `host`, as the shell does; returns its result. */
async function run(host: Host, argv: string[]): Promise<Record<string, unknown>> {
  let result: Record<string, unknown> | undefined;
  const output: CallOutput = { result: (data) => { result = JSON.parse(JSON.stringify(data)) as Record<string, unknown>; }, stdout: () => {}, stderr: () => {} };
  const args = parseArgs([...argv, '--json']);
  await dispatchCommand(installedCommands, argv[0] as string, args, {
    signal: new AbortController().signal,
    output,
    host,
    loadPayer: async () => (await import('../lib/serve-payer.ts')).servePayer,
    loadProtectors: async () => [(await import('../lib/grant/account-protector.ts')).accountProtector],
  });
  if (result === undefined) throw new Error(`${argv.join(' ')} wrote no result`);
  return result;
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-two-hosts-')));
  // The process's home is a third, empty folder: neither host's state may land there.
  processHome = path.join(base, 'process-home');
  fs.mkdirSync(processHome);
  originalHome = process.env.HOME;
  process.env.HOME = processHome;
  // A passphrase neither host has, and a watch on what the process's environment is asked for.
  originalEnv = process.env;
  envReads = [];
  const watched = { ...originalEnv, MN_PASSPHRASE: PROCESS_PASSPHRASE };
  process.env = new Proxy(watched, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^(MN_|BLOCKFROST_|HOME$)/.test(key)) envReads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
});

afterEach(() => {
  process.env = originalEnv;
  process.env.HOME = originalHome;
  fs.rmSync(base, { recursive: true, force: true });
});

describe('two hosts in one process, each with its own state root and settings', () => {
  it('run real commands without mixing: wallets, passphrases, config and open swap offers stay each in its own host', async () => {
    const indexer = await startSpendIndexer();
    try {
      const hostA = hostAt(path.join(base, 'a'), PASSPHRASE_A);
      const hostB = hostAt(path.join(base, 'b'), PASSPHRASE_B);
      const rootA = hostA.paths().stateRoot;
      const rootB = hostB.paths().stateRoot;

      // Each sets its own config: the network, its own node, and the indexer both read offers from.
      for (const [host, node] of [[hostA, 'ws://127.0.0.1:19944'], [hostB, 'ws://127.0.0.1:29944']] as const) {
        expect(await run(host, ['config', 'set', 'network', 'undeployed'])).toEqual({ action: 'set', key: 'network', value: 'undeployed' });
        expect(await run(host, ['config', 'set', 'node', node])).toEqual({ action: 'set', key: 'node', value: node });
        await run(host, ['config', 'set', 'indexer-ws', indexer.wsUrl]);
      }
      expect(await run(hostA, ['config', 'get', 'node'])).toEqual({ action: 'get', key: 'node', value: 'ws://127.0.0.1:19944' });
      expect(await run(hostB, ['config', 'get', 'node'])).toEqual({ action: 'get', key: 'node', value: 'ws://127.0.0.1:29944' });

      // Each generates a wallet, sealed under its own host's passphrase.
      const alice = await run(hostA, ['wallet', 'generate', 'alice']);
      const bob = await run(hostB, ['wallet', 'generate', 'bob']);
      expect(alice.file).toBe(path.join(rootA, 'wallets', 'alice.json'));
      expect(bob.file).toBe(path.join(rootB, 'wallets', 'bob.json'));
      expect(() => checkPassphrase(rootA, PASSPHRASE_A)).not.toThrow();
      expect(() => checkPassphrase(rootB, PASSPHRASE_B)).not.toThrow();
      expect(() => checkPassphrase(rootA, PASSPHRASE_B)).toThrow();
      expect(() => checkPassphrase(rootB, PASSPHRASE_A)).toThrow();
      expect(() => checkPassphrase(rootA, PROCESS_PASSPHRASE)).toThrow();
      expect(() => checkPassphrase(rootB, PROCESS_PASSPHRASE)).toThrow();

      // Each lists its own wallets, and only those.
      const names = (listed: Record<string, unknown>) => (listed.wallets as { name: string }[]).map((w) => w.name);
      expect(names(await run(hostA, ['wallet', 'list']))).toEqual(['alice']);
      expect(names(await run(hostB, ['wallet', 'list']))).toEqual(['bob']);

      // Each wallet's open offer is recorded under its own host's root, as `swap make` records it; each host lists its own.
      const addressA = (alice.addresses as Record<string, string>).undeployed as string;
      const addressB = (bob.addresses as Record<string, string>).undeployed as string;
      recordOpenOffer(rootA, 'undeployed', addressA, offer('a1', 'aa'));
      recordOpenOffer(rootB, 'undeployed', addressB, offer('b2', 'bb'));
      const ids = (listed: Record<string, unknown>) => (listed.offers as { id: string; taken: boolean }[]).map((o) => `${o.id.slice(0, 4)} ${o.taken ? 'taken' : 'open'}`);
      expect(ids(await run(hostA, ['swap', 'list']))).toEqual(['a1a1 open']);
      expect(ids(await run(hostB, ['swap', 'list']))).toEqual(['b2b2 open']);
      expect(indexer.asked).toEqual([['aa'.repeat(32)], ['bb'.repeat(32)]]);

      // Nothing in the process's home, and no setting asked of the process's environment.
      expect(fs.readdirSync(processHome)).toEqual([]);
      expect(fs.readdirSync(base).sort()).toEqual(['a', 'b', 'process-home']);
      expect(envReads).toEqual([]);
    } finally {
      await indexer.close();
    }
  });
});
