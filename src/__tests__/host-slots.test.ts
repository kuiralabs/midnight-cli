// Two hosts in one process ask, say and remember apart: an approval asks its
// own host's prompter and says what it decided through its own host's
// notices; a passphrase one host unlocked is not unlocked in the other (same
// state root); a plain-text wallet is warned about once per host; and each
// host's RPC servers number their connections from their own count.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { createHost, type Host, type Prompter } from '@kuiralabs/midnight-cli-core';
import { promptApproval } from '@kuiralabs/midnight-cli-core/engine';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import { NoPassphraseError, PASSPHRASE_ENV, establishPassphrase, unlockPassphrase } from '../lib/passphrase.ts';
import { unlockWallet } from '../lib/wallet-config.ts';
import { createRpcServer, type RpcServer } from '../lib/ws-rpc.ts';
import { rcKeys } from '../../test-support/rc-engine.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';
import { stateRootIn } from './helpers/state-root-in.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';

/** A prompter at a terminal that answers every question with `answer`, keeping the questions. */
function answering(answer: string): Prompter & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    isInteractive: () => true,
    ask: async (question) => { questions.push(question); return answer; },
    askSecret: async (question) => { questions.push(question); return answer; },
  };
}

/** A host whose notices land in `lines`, asking through `prompter`, with an engine of its own from the engines the CLI ships. */
const hostSaying = (lines: string[], prompter: Prompter | null = null): Host =>
  createHost({ notice: (line) => lines.push(line), prompter, engineLoader: loadInstalledEngine });

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-host-slots-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('an approval', () => {
  it("asks its own host's prompter, and says what it decided through its own host's notices", async () => {
    const promptedA = answering('a');
    const promptedB = answering('r');
    const saidA: string[] = [];
    const saidB: string[] = [];
    const hostA = hostSaying(saidA, promptedA);
    const hostB = hostSaying(saidB, promptedB);
    const request = (method: string) => ({ method, network: 'undeployed', details: [] });

    // Both at once: each host's prompter answers its own, neither waits on the other's.
    const [a, b] = await Promise.all([
      promptApproval(request('makeTransfer'), { prompter: hostA.prompter, notice: hostA.notice }),
      promptApproval(request('signData'), { prompter: hostB.prompter, notice: hostB.notice }),
    ]);

    expect([a, b]).toEqual(['approve', 'reject']);
    expect(promptedA.questions).toHaveLength(1);
    expect(promptedA.questions[0]).toContain('makeTransfer');
    expect(promptedB.questions).toHaveLength(1);
    expect(promptedB.questions[0]).toContain('signData');

    await promptApproval(request('makeIntent'), { approveAll: true, prompter: hostB.prompter, notice: hostB.notice });
    expect(saidA).toEqual([]);
    expect(saidB.join('\n')).toContain('Auto-approved: makeIntent');
    expect(promptedB.questions).toHaveLength(1);
  });
});

describe('the unlocked passphrase', () => {
  it('is kept by the host that unlocked it: another host, over the same state root, asks again', async () => {
    const root = stateRootIn(home);
    establishPassphrase(root, PASSPHRASE);
    const hostA = createHost();
    const hostB = createHost();

    expect(await unlockPassphrase(hostA, root, { env: { [PASSPHRASE_ENV]: PASSPHRASE } })).toBe(PASSPHRASE);
    // Neither host has a prompter, and the environment names none now: only one that unlocked it before has it.
    expect(await unlockPassphrase(hostA, root, { env: {} })).toBe(PASSPHRASE);
    await expect(unlockPassphrase(hostB, root, { env: {} })).rejects.toThrow(NoPassphraseError);
  });
});

describe('the plain-text wallet warning', () => {
  it("is said once per host, through that host's notices", async () => {
    const root = stateRootIn(home);
    const wallet = saveWalletConfig(
      { seed: SEED, addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex')), createdAt: '2026-11-03T00:00:00.000Z' },
      path.join(root, 'wallets', 'plain.json'),
    );
    const saidA: string[] = [];
    const saidB: string[] = [];
    const hostA = hostSaying(saidA);
    const hostB = hostSaying(saidB);

    await unlockWallet(wallet, { root, host: hostA });
    await unlockWallet(wallet, { root, host: hostA });
    await unlockWallet(wallet, { root, host: hostB });

    expect(saidA).toHaveLength(1);
    expect(saidA[0]).toMatch(/Warning: wallet .*plain\.json is not protected: its seed is in plain text/);
    expect(saidB).toEqual(saidA);
  });
});

describe('RPC connection ids', () => {
  const servers: RpcServer[] = [];
  const clients: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of clients) ws.close();
    clients.length = 0;
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  /** A server of `host`'s on a free port, and the ids of the connections it accepts. */
  async function serverOf(host: Host): Promise<{ port: number; ids: string[] }> {
    const ids: string[] = [];
    const server = createRpcServer({ host, port: 0, handlers: {}, onConnect: (conn) => ids.push(conn.id) });
    servers.push(server);
    await server.ready;
    return { port: (server.wss.address() as { port: number }).port, ids };
  }

  const connect = (port: number): Promise<void> => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.push(ws);
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });

  it("count per host: each host's servers number their connections from its own count", async () => {
    const hostA = createHost();
    const hostB = createHost();
    const a1 = await serverOf(hostA);
    const a2 = await serverOf(hostA);
    const b = await serverOf(hostB);

    await connect(a1.port);
    await connect(b.port);
    await connect(a2.port);
    await connect(b.port);
    // The server sees a connection once its handshake is done, a moment after the client does.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect([...a1.ids, ...a2.ids]).toEqual(['conn_1', 'conn_2']);
    expect(b.ids).toEqual(['conn_1', 'conn_2']);
  });
});
