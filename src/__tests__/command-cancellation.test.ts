// Every command honours its call's cancellation. The 13 that ignored
// it: quick ones never start once cancelled (the runners refuse the call);
// the ones that write check before each whole write; balance, status and
// inspect-cost pass the signal into their reads; localnet is in
// localnet-cancellation.test.ts. Each case asserts CANCELLED, and that nothing
// was written or reported. Nothing here reaches a chain: the reads go to
// stand-ins run by the test, or to a stubbed fetch (status, whose endpoints
// are hosted ones).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { installedCommands } from '../lib/installed-commands.ts';
import type { Prompter } from '@kuiralabs/midnight-cli-core/lib/prompter';
import { establishPassphrase, isPassphraseSet } from '../lib/passphrase.ts';
import { deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { getCachePath } from '@kuiralabs/midnight-cli-core/lib/wallet-cache';
import { loadWalletConfig, protectAllWallets } from '../lib/wallet-config.ts';
import { createWallet, walletSecretFrom } from '../lib/wallet-create.ts';
import type { WalletProtector } from '../lib/wallet-protector.ts';
import type { CommandHandler } from '@kuiralabs/midnight-cli-core/lib/call-context';
import balanceCommand from '../commands/balance.ts';
import inspectCostCommand from '../commands/inspect-cost.ts';
import statusCommand from '@kuiralabs/midnight-chain/commands/status';
import generateCommand from '../commands/generate.ts';
import walletCommand from '../commands/wallet.ts';
import cacheCommand from '../commands/cache.ts';
import testCommand from '../commands/test.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';
import { testHost } from './helpers/test-host.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';
import { stateRootIn } from './helpers/state-root-in.ts';
import { startRefusingEndpoint, startStandInIndexer, type StandInIndexer } from './helpers/stand-in-indexer.ts';

const PASSPHRASE = 'correct horse battery staple';

let home: string;
let io: CapturedOutput;
const originalHome = process.env.HOME;
const originalPassphrase = process.env.MN_PASSPHRASE;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-command-cancel-')));
  process.env.HOME = home;
  delete process.env.MN_PASSPHRASE;
  io = captureOutput();
});

afterEach(() => {
  io.restore();
  process.env.HOME = originalHome;
  if (originalPassphrase === undefined) delete process.env.MN_PASSPHRASE;
  else process.env.MN_PASSPHRASE = originalPassphrase;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A prompter that answers every passphrase question, and cancels the call as it is first asked. */
function cancellingPrompter(call: AbortController): Prompter & { asked: number } {
  const prompter = {
    asked: 0,
    isInteractive: () => true,
    ask: async () => null,
    askSecret: async () => {
      prompter.asked += 1;
      call.abort();
      return PASSPHRASE;
    },
  };
  return prompter;
}

const cancelled = (): AbortSignal => {
  const call = new AbortController();
  call.abort();
  return call.signal;
};

describe('quick commands: a cancelled call never starts', () => {
  const quick: ReadonlyArray<readonly string[]> = [
    ['info', '--json'],
    ['address', '--seed', 'aa'.repeat(32), '--json'],
    ['genesis-address', '--json'],
    ['config', 'set', 'network', 'preview', '--json'],
    ['help', '--json'],
    ['manual', '--json'],
    ['wallet', 'list', '--json'],
    ['wallet', 'use', 'alice', '--json'],
    ['cache', 'clear', '--json'],
  ];

  it.each(quick)('%s: CANCELLED, with no result and nothing written', async (...argv) => {
    const definition = installedCommands.find(argv[0]!)!;
    const { default: handler } = await definition.load();
    await expect(cliCall(handler as CommandHandler, parseArgs([...argv]), { signal: cancelled() })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(io.stdout()).toBe('');
    // Nothing under the state root: no config, no wallet, nothing cleared or created.
    expect(fs.existsSync(stateRootIn(home))).toBe(false);
  });
});

describe('balance passes the signal into its reads', () => {
  let indexer: StandInIndexer;
  let refusing: { port: number; close(): Promise<void> };

  beforeEach(async () => {
    // Four transactions, 200ms apart: the call is cancelled after the first.
    indexer = await startStandInIndexer([1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n], 200);
    refusing = await startRefusingEndpoint();
  });

  afterEach(async () => {
    await indexer.close();
    await refusing.close();
  });

  const endpoints = (): string[] => ['--indexer-ws', indexer.url, '--node', `ws://127.0.0.1:${refusing.port}`, '--proof-server', `http://127.0.0.1:${refusing.port}`];

  it('an address\'s balance: the subscription closes at once and the call answers CANCELLED with no result', async () => {
    const address = deriveUnshieldedAddress(Buffer.from('aa'.repeat(32), 'hex'), 'undeployed');
    const call = new AbortController();
    void indexer.sentAtLeast(1).then(() => call.abort());

    await expect(cliCall(balanceCommand, parseArgs(['balance', address, '--json', ...endpoints()]), { signal: call.signal })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(io.stdout()).toBe('');
    expect(indexer.subscriptions).toHaveLength(1);
    await expect.poll(() => indexer.subscriptions[0]!.closedEarly).toBe(true);
    expect(indexer.subscriptions[0]!.done).toBe(false);
  });

  it('a wallet\'s balance: its unshielded read stops at once, and the call answers CANCELLED with no result', async () => {
    const call = new AbortController();
    void indexer.sentAtLeast(1).then(() => call.abort());

    await expect(cliCall(balanceCommand, parseArgs(['balance', '--seed', 'bb'.repeat(32), '--network', 'undeployed', '--json', ...endpoints()]), { signal: call.signal })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(io.stdout()).toBe('');
    await expect.poll(() => indexer.subscriptions[0]?.closedEarly).toBe(true);
    expect(indexer.subscriptions[0]!.done).toBe(false);
  });
});

describe('inspect-cost passes the signal into its reads', () => {
  let server: Server;
  let pending: number;

  beforeEach(async () => {
    // An indexer that takes every query and never answers.
    pending = 0;
    server = createServer(() => { pending += 1; });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('cancelled while the indexer has not answered: CANCELLED at once, with no result', async () => {
    const { port } = server.address() as AddressInfo;
    const call = new AbortController();
    let cancelledAt = 0;
    server.once('request', () => { cancelledAt = Date.now(); call.abort(); });

    await expect(cliCall(inspectCostCommand, parseArgs(['inspect-cost', '--network', 'undeployed', '--indexer-ws', `ws://127.0.0.1:${port}/api/v4/graphql/ws`, '--json']), { signal: call.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });

    // Before the signal reached it, it waited out the probe's own 5s time limit, then went on to read the parameters.
    expect(cancelledAt).toBeGreaterThan(0);
    expect(Date.now() - cancelledAt).toBeLessThan(2_000);
    expect(pending).toBe(1);
    expect(io.stdout()).toBe('');
  });
});

describe('status passes the signal into its probes', () => {
  // status reads hosted endpoints (the dashboard, the network's indexer and node): fetch, the platform's, stands in for them.
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  /** A fetch that never answers until its request is aborted, keeping each request's signal; `onFetch` sees how many have started. */
  function hangingFetch(onFetch: (started: number) => void): { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!;
      signals.push(signal);
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      onFetch(signals.length);
    })) as typeof fetch;
    return { signals };
  }

  it('cancelled while its probes run: every request is aborted, and it answers CANCELLED with no result', async () => {
    const call = new AbortController();
    // Cancelled once all four requests are out.
    const fetches = hangingFetch((started) => { if (started === 4) call.abort(); });

    await expect(cliCall(statusCommand, parseArgs(['status', '--network', 'preprod', '--json']), { signal: call.signal })).rejects.toMatchObject({ code: 'CANCELLED' });

    // The dashboard's two, and the network's faucet and explorer (its indexer and node need a Blockfrost project id, which the test gives none).
    expect(fetches.signals).toHaveLength(4);
    expect(fetches.signals.every((signal) => signal.aborted)).toBe(true);
    expect(io.stdout()).toBe('');
  });

  it('--watch ends when the call is cancelled, as Ctrl+C always ended it: exit 0', async () => {
    // Regression: the watch waited for SIGINT on the process, and a cancelled call never ended.
    const answer = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith('/api/status')) return answer({ lastUpdated: null, networks: {} });
      if (url.endsWith('/api/issues')) return answer({ lastUpdated: '2026-10-31T00:00:00.000Z', issues: [] });
      return answer({});
    }) as typeof fetch;
    const call = new AbortController();
    // Cancelled once the first view is drawn, its last line the dashboard's link: the watch has begun.
    const drawn = setInterval(() => { if (io.stderr().includes('Dashboard:')) { clearInterval(drawn); call.abort(); } }, 10);

    await expect(cliCall(statusCommand, parseArgs(['status', '--network', 'preprod', '--watch']), { signal: call.signal })).resolves.toEqual({ exitCode: 0 });
    clearInterval(drawn);
  });
});

describe('commands that write check the call before each whole write', () => {
  it('generate: cancelled while the passphrase is asked for, it writes no wallet', async () => {
    const call = new AbortController();
    const prompter = cancellingPrompter(call);
    const target = path.join(home, 'legacy-wallet.json');

    await expect(cliCall(generateCommand, parseArgs(['generate', '--output', target, '--json']), { signal: call.signal, host: testHost({ prompter }) })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(prompter.asked).toBeGreaterThan(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(io.stdout()).toBe('');
    expect(isPassphraseSet(stateRootIn(home)), 'no new passphrase saved').toBe(false);
  });

  it('wallet generate: cancelled while the passphrase is asked for, it writes no wallet', async () => {
    const call = new AbortController();
    const prompter = cancellingPrompter(call);

    await expect(cliCall(walletCommand, parseArgs(['wallet', 'generate', 'alice', '--json']), { signal: call.signal, host: testHost({ prompter }) })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(prompter.asked).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(stateRootIn(home), 'wallets', 'alice.json'))).toBe(false);
    expect(io.stdout()).toBe('');
    expect(isPassphraseSet(stateRootIn(home)), 'no new passphrase saved').toBe(false);
  });

  describe('wallet protect', () => {
    const plainWallet = (name: string, seedByte: string): string => {
      const seed = seedByte.repeat(32);
      return saveWalletConfig({
        seed,
        addresses: { undeployed: deriveUnshieldedAddress(Buffer.from(seed, 'hex'), 'undeployed') } as never,
        createdAt: '2026-10-31T00:00:00.000Z',
      }, path.join(stateRootIn(home), 'wallets', `${name}.json`));
    };
    const isSealed = async (file: string): Promise<boolean> => (await loadWalletConfig(file, testHost().engines)).isSealed === true;

    it('cancelled while the passphrase is asked for: no wallet is sealed', async () => {
      const files = [plainWallet('alice', 'a1'), plainWallet('bob', 'b2')];
      const call = new AbortController();

      await expect(cliCall(walletCommand, parseArgs(['wallet', 'protect', '--json']), { signal: call.signal, host: testHost({ prompter: cancellingPrompter(call) }) })).rejects.toMatchObject({ code: 'CANCELLED' });

      expect(await Promise.all(files.map(isSealed))).toEqual([false, false]);
      expect(io.stdout()).toBe('');
      expect(isPassphraseSet(stateRootIn(home)), 'no new passphrase saved').toBe(false);
    });

    it('cancelled while one wallet is sealed: that one is sealed whole, and the next is not touched', async () => {
      const files = [plainWallet('alice', 'a1'), plainWallet('bob', 'b2'), plainWallet('carol', 'c3')];
      const call = new AbortController();

      const protecting = protectAllWallets(stateRootIn(home), PASSPHRASE, testHost().engines, call.signal);
      // Lands while the first wallet is being sealed: after the first turn of the event loop, before the second.
      setImmediate(() => call.abort());

      await expect(protecting).rejects.toMatchObject({ code: 'CANCELLED' });
      expect(await Promise.all(files.map(isSealed))).toEqual([true, false, false]);
    });

    it('cancelled by a protector: the protectors after it do not run', async () => {
      plainWallet('alice', 'a1');
      process.env.MN_PASSPHRASE = PASSPHRASE;
      const call = new AbortController();
      const ran: string[] = [];
      const protector = (name: string, then: () => void = () => {}): WalletProtector => ({
        name,
        protect: async () => {
          ran.push(name);
          then();
          return { items: [], report: {} };
        },
      });

      await expect(cliCall(walletCommand, parseArgs(['wallet', 'protect', '--json']), {
        signal: call.signal,
        protectors: [protector('grant', () => call.abort()), protector('later')],
      })).rejects.toMatchObject({ code: 'CANCELLED' });

      expect(ran).toEqual(['grant']);
      expect(io.stdout()).toBe('');
    });
  });

  it('cache clear --wallet: cancelled while the wallet is unlocked, it clears no cache', async () => {
    establishPassphrase(stateRootIn(home), PASSPHRASE);
    const created = await createWallet(stateRootIn(home), 'alice', walletSecretFrom(), PASSPHRASE, await testHost().engines.any());
    const cache = getCachePath(created.addresses.undeployed, 'undeployed', stateRootIn(home));
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, '{}');
    const call = new AbortController();

    await expect(cliCall(cacheCommand, parseArgs(['cache', 'clear', '--wallet', 'alice', '--network', 'undeployed', '--json']), { signal: call.signal, host: testHost({ prompter: cancellingPrompter(call) }) })).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(fs.existsSync(cache)).toBe(true);
    expect(io.stdout()).toBe('');
  });
});

describe('test create, cancelled while Claude scaffolds', () => {
  const originalPath = process.env.PATH;
  afterEach(() => { process.env.PATH = originalPath; });

  it('stops Claude, does not fall back to the plain scaffold, and writes no suite', async () => {
    // A dApp with one compiled contract.
    const dapp = path.join(home, 'dapp');
    const compiler = path.join(dapp, 'managed', 'counter', 'compiler');
    fs.mkdirSync(compiler, { recursive: true });
    fs.writeFileSync(path.join(compiler, 'contract-info.json'), JSON.stringify({
      'compiler-version': '0.30.0', 'language-version': '0.22.0', 'runtime-version': '0.15.0',
      circuits: [{ name: 'increment', pure: false, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } }],
      witnesses: [],
    }));
    // A `claude` that says its version, then records its pid and never answers.
    const bin = path.join(home, 'bin');
    const started = path.join(home, 'claude.pid');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\n[ "$1" = "--version" ] && { echo 1.0.0; exit 0; }\necho $$ > "${started}"\nexec sleep 60\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;

    const call = new AbortController();
    const run = cliCall(testCommand, parseArgs(['test', 'create', '--path', dapp, '--goal', 'count up', '--json']), { signal: call.signal });
    await expect.poll(() => fs.existsSync(started) && fs.readFileSync(started, 'utf8').trim() !== '', { timeout: 10_000 }).toBe(true);
    const pid = Number(fs.readFileSync(started, 'utf8').trim());
    call.abort();

    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect.poll(() => { try { process.kill(pid, 0); return 'running'; } catch { return 'gone'; } }, { timeout: 5_000 }).toBe('gone');
    expect(fs.existsSync(path.join(dapp, 'dapp.test.json'))).toBe(false);
    expect(io.stderr()).not.toContain('falling back to deterministic');
    expect(io.stdout()).toBe('');
  }, 20_000);
});
