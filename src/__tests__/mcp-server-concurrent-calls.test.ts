// Two calls at once in one real MCP server, one of
// them cancelled. Run through this checkout's MCP server as a process of its
// own, over stdio, with a temporary home. Each call reads an address's balance
// from its own stand-in indexer (a WebSocket run by this test, answering
// slowly, with different balances); the node and proof server point at an
// endpoint that refuses every connection, so nothing reaches a chain.
//
// Asserted: call A, cancelled through the client's signal, stops in the
// server (its indexer sees the connection closed before it finished) and no
// answer for it crosses the channel (MCP: a cancelled request gets none, so
// its client answers it CANCELLED-by-abort); call B completes with its own
// balance and address, and its progress holds only its own messages; the
// channel stays valid, so a third call afterwards works.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCMessage, Progress } from '@modelcontextprotocol/sdk/types.js';
import { deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { toNight } from '@kuiralabs/midnight-cli-core/ui/format';
import { startRefusingEndpoint, startStandInIndexer, type StandInIndexer } from './helpers/stand-in-indexer.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

const addressOf = (byte: string): string => deriveUnshieldedAddress(Buffer.from(byte.repeat(32), 'hex'), 'undeployed');
const ADDRESS_A = addressOf('aa');
const ADDRESS_B = addressOf('bb');
const ADDRESS_C = addressOf('cc');

// A: four transactions of 10 NIGHT; B: three, 7 NIGHT in all. Each 300ms apart.
const VALUES_A = [10_000_000n, 10_000_000n, 10_000_000n, 10_000_000n];
const VALUES_B = [1_000_000n, 2_000_000n, 4_000_000n];
const STEP_MS = 300;

let home: string;
let client: Client;
let indexerA: StandInIndexer;
let indexerB: StandInIndexer;
let refusing: { port: number; close(): Promise<void> };
/** Every JSON-RPC message the server sent, and every one the client sent, in order. */
const fromServer: JSONRPCMessage[] = [];
const fromClient: JSONRPCMessage[] = [];
const channelErrors: Error[] = [];

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-concurrent-home-')));
  indexerA = await startStandInIndexer(VALUES_A, STEP_MS);
  indexerB = await startStandInIndexer(VALUES_B, STEP_MS);
  refusing = await startRefusingEndpoint();

  const env = { ...process.env, HOME: home, NO_COLOR: '1', MN_PASSPHRASE: 'correct horse battery staple' } as Record<string, string>;
  const transport = new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' });
  client = new Client({ name: 'mn-test', version: '0' });
  client.onerror = (error) => { channelErrors.push(error); };
  await client.connect(transport);
  // Watch the channel both ways, beneath the client.
  const deliver = transport.onmessage!;
  transport.onmessage = (message) => { fromServer.push(message); deliver(message); };
  const send = transport.send.bind(transport);
  transport.send = (message: JSONRPCMessage) => { fromClient.push(message); return send(message); };
}, 60_000);

afterAll(async () => {
  await client?.close();
  await indexerA?.close();
  await indexerB?.close();
  await refusing?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A balance call for `address`, read from `indexer`; the node and proof server refuse. */
const balanceOf = (address: string, indexer: StandInIndexer) => ({
  name: 'midnight_balance',
  arguments: {
    address,
    full: true,
    'indexer-ws': indexer.url,
    node: `ws://127.0.0.1:${refusing.port}`,
    'proof-server': `http://127.0.0.1:${refusing.port}`,
  },
});

const resultOf = (answer: unknown): Record<string, unknown> =>
  JSON.parse(((answer as { content: Array<{ text: string }> }).content)[0]!.text) as Record<string, unknown>;

/** The id of the tools/call request the client sent for `address`. */
function requestIdFor(address: string): unknown {
  const sent = fromClient.find((m) => 'method' in m && m.method === 'tools/call'
    && (m.params as { arguments?: { address?: string } } | undefined)?.arguments?.address === address);
  expect(sent, `a tools/call for ${address}`).toBeDefined();
  return (sent as { id: unknown }).id;
}

/** The progress token the client sent with its tools/call for `address`. */
function progressTokenFor(address: string): unknown {
  const sent = fromClient.find((m) => 'method' in m && m.method === 'tools/call'
    && (m.params as { arguments?: { address?: string } } | undefined)?.arguments?.address === address);
  return (sent as { params: { _meta?: { progressToken?: unknown } } } | undefined)?.params._meta?.progressToken;
}

/** The progress notifications the server sent for the call for `address`, with where each is on the channel. */
function progressOnChannel(address: string): Array<{ message: string; progress: number; at: number }> {
  const token = progressTokenFor(address);
  expect(token, `a progress token for ${address}`).toBeDefined();
  return fromServer.flatMap((m, at) => {
    if (!('method' in m) || m.method !== 'notifications/progress') return [];
    const params = m.params as { progressToken: unknown; progress: number; message: string };
    return params.progressToken === token ? [{ message: params.message, progress: params.progress, at }] : [];
  });
}

describe('two MCP calls at once, one cancelled', () => {
  it('A stops and gets no answer; B keeps its own result and progress; the channel stays valid', async () => {
    const callA = new AbortController();
    const progressA: Progress[] = [];
    const progressB: Progress[] = [];

    const answerA = client.callTool(balanceOf(ADDRESS_A, indexerA), undefined, { signal: callA.signal, onprogress: (p) => progressA.push(p) });
    const answerB = client.callTool(balanceOf(ADDRESS_B, indexerB), undefined, { onprogress: (p) => progressB.push(p) });

    // A is cancelled mid-read: once its indexer has sent its first transaction, and the server has said so.
    await indexerA.sentAtLeast(1);
    await expect.poll(() => progressA.map((p) => p.message)).toContain('Syncing transactions... 25%');
    callA.abort(new Error('cancelled by the test'));

    // The client answers A with its own cancellation; the server stops A's read.
    await expect(answerA).rejects.toThrow('cancelled by the test');
    await expect.poll(() => indexerA.subscriptions[0]?.closedEarly, { timeout: 5_000 }).toBe(true);
    expect(indexerA.subscriptions[0]!.done).toBe(false);
    expect(indexerA.subscriptions[0]!.sent).toBeLessThan(VALUES_A.length);

    // B runs to its end with its own balance, for its own address.
    const resultB = resultOf(await answerB);
    expect(resultB).toMatchObject({
      address: ADDRESS_B,
      network: 'undeployed',
      balances: { NIGHT: toNight(7_000_000n) },
      NIGHT: toNight(7_000_000n),
      utxoCount: 3,
      txCount: 3,
    });
    expect(indexerB.subscriptions.map((s) => s.address)).toEqual([ADDRESS_B]);
    expect(indexerB.subscriptions[0]!.done).toBe(true);

    // B's progress is B's alone: its messages, numbered from 1, none of A's,
    // all sent before B's answer. Read on the channel: the client drops a
    // progress notification that arrives in the same read as its call's
    // answer (it handles the answer first), so its callback can miss the last.
    const idB = requestIdFor(ADDRESS_B);
    expect(progressOnChannel(ADDRESS_B).map((p) => p.message)).toEqual([
      'Checking balance on undeployed...',
      'Syncing transactions... 33%',
      'Syncing transactions... 67%',
      'Syncing transactions... 100%',
      'Synced 3 transactions',
    ]);
    expect(progressOnChannel(ADDRESS_B).map((p) => p.progress)).toEqual([1, 2, 3, 4, 5]);
    expect(Math.max(...progressOnChannel(ADDRESS_B).map((p) => p.at))).toBeLessThan(fromServer.findIndex((m) => 'id' in m && m.id === idB));
    expect(progressB.map((p) => p.message)).toEqual(progressOnChannel(ADDRESS_B).slice(0, progressB.length).map((p) => p.message));
    // A's progress is A's alone, and stopped with it.
    expect(progressOnChannel(ADDRESS_A).map((p) => p.message)).toEqual(['Checking balance on undeployed...', 'Syncing transactions... 25%']);
    expect(progressA.map((p) => p.message)).toEqual(['Checking balance on undeployed...', 'Syncing transactions... 25%']);

    // The server sent nothing for A after the cancellation: no result, no error, no progress.
    const idA = requestIdFor(ADDRESS_A);
    expect(fromServer.filter((m) => 'id' in m && m.id === idA)).toEqual([]);
    // Every answer the server sent is B's: none carries A's address or balance.
    const answers = fromServer.filter((m) => 'result' in m && JSON.stringify(m.result).includes('content'));
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0])).not.toContain(ADDRESS_A);

    // The channel is still valid: a third call afterwards works, with its own answer.
    const resultC = resultOf(await client.callTool(balanceOf(ADDRESS_C, indexerB)));
    expect(resultC).toMatchObject({ address: ADDRESS_C, balances: { NIGHT: toNight(7_000_000n) }, utxoCount: 3 });
    // The only error the client may report is that drop: B's last progress, after B's answer.
    const others = channelErrors.filter((error) => !(error.message.startsWith('Received a progress notification for an unknown token')
      && error.message.includes(`"progressToken":${JSON.stringify(progressTokenFor(ADDRESS_B))}`)
      && error.message.includes('Synced 3 transactions')));
    expect(others).toEqual([]);
  }, 60_000);
});
