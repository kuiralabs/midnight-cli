// The reads balance, inspect-cost and localnet's readiness waits make take
// the call's signal: cancelled, each stops at once with
// CancelledError (code CANCELLED), instead of waiting out its own time limit.
// The endpoints are servers run by the test that take each request and never
// answer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { callNodeRpc } from '../lib/node-rpc.ts';
import { clearChainIdMemo, getChainGenesisHash } from '../lib/chain-id.ts';
import { queryIndexer } from '../lib/indexer-graphql.ts';
import { fetchProtocolVersion } from '../lib/ledger-guard.ts';
import { checkBalance } from '../lib/balance-subscription.ts';
import { waitForFirstBlock } from '../lib/node-ready.ts';
import { waitForAddressFunded } from '../lib/indexer-ready.ts';
import { waitForProofServerReady } from '../lib/proof-server-ready.ts';
import { sleep } from '@kuiralabs/midnight-cli-core';

let http: Server;
let ws: WebSocketServer;
let httpUrl: string;
let wsUrl: string;
let requests: number;

beforeEach(async () => {
  requests = 0;
  // Takes every request, never answers.
  http = createServer(() => { requests += 1; });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;
  // Accepts every connection and message, never answers.
  ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => ws.once('listening', () => resolve()));
  ws.on('connection', (socket) => socket.on('message', () => { requests += 1; }));
  wsUrl = `ws://127.0.0.1:${(ws.address() as AddressInfo).port}`;
  clearChainIdMemo();
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  for (const client of ws.clients) client.terminate();
  await new Promise<void>((resolve) => ws.close(() => resolve()));
});

/** Cancels the call once the endpoint has its first request, and says how long the read then took to stop. */
async function cancelledOnceAsked<T>(read: (signal: AbortSignal) => Promise<T>): Promise<{ error: unknown; elapsedMs: number }> {
  const call = new AbortController();
  let cancelledAt = 0;
  const watching = setInterval(() => {
    if (requests > 0 && !call.signal.aborted) { cancelledAt = Date.now(); call.abort(); }
  }, 10);
  const since = (): number => (cancelledAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - cancelledAt);
  try {
    await read(call.signal);
    return { error: undefined, elapsedMs: since() };
  } catch (error) {
    return { error, elapsedMs: since() };
  } finally {
    clearInterval(watching);
  }
}

const expectCancelledAtOnce = ({ error, elapsedMs }: { error: unknown; elapsedMs: number }): void => {
  expect(error).toMatchObject({ code: 'CANCELLED' });
  expect(elapsedMs).toBeLessThan(1_500);
};

describe('reads, cancelled while the endpoint has not answered', () => {
  it('a node RPC call', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => callNodeRpc({ url: wsUrl, timeoutMs: 5_000, signal }, 'chain_getHeader')));
  });

  it('the chain\'s genesis hash, which otherwise answers null when the node can\'t say', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => getChainGenesisHash(wsUrl, signal)));
  });

  it('an indexer query', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => queryIndexer(httpUrl, '{ block { height } }', undefined, 5_000, signal)));
  });

  it('the chain\'s protocol version, which otherwise answers null when the indexer can\'t say', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => fetchProtocolVersion(httpUrl, signal)));
  });

  it('an unshielded balance subscription', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => checkBalance('mn_addr_undeployed1x', wsUrl, undefined, signal)));
  });
});

describe('localnet up\'s readiness waits, cancelled', () => {
  it('waiting for the first block', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => waitForFirstBlock(wsUrl, { timeoutMs: 10_000, signal })));
  });

  it('waiting for the indexer to show funds', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => waitForAddressFunded(wsUrl, 'mn_addr_undeployed1x', { timeoutMs: 10_000, signal })));
  });

  it('waiting for the proof server', async () => {
    expectCancelledAtOnce(await cancelledOnceAsked((signal) => waitForProofServerReady(httpUrl, { timeoutMs: 10_000, requestTimeoutMs: 5_000, signal })));
  });

  it('the wait between polls', async () => {
    const call = new AbortController();
    setTimeout(() => call.abort(), 20);
    await expect(sleep(10_000, call.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
