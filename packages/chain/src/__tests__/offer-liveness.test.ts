// Whether a swap offer's coins are spent, asked of the indexer before a taker
// builds anything. A real in-process HTTP server answers the tip query and a
// real WebSocket server speaks graphql-transport-ws as the indexer does,
// ending the bounded subscription with complete.

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { spendsOf, LivenessUnknownError } from '../lib/offer-liveness.ts';
import { startLocalIndexer, type LocalIndexer } from '../../../../test-support/local-indexer.ts';

const N1 = 'aa'.repeat(32);
const N2 = 'bb'.repeat(32);

let servers: WebSocketServer[] = [];
let http: LocalIndexer | undefined;
afterEach(async () => { for (const s of servers) s.close(); servers = []; await http?.close(); http = undefined; });

/** The indexer's subscription side: on subscribe, sends `spends` as next payloads, then complete unless told not to. */
async function subscriptions(spends: unknown[], complete = true): Promise<{ url: string; subscribed: Array<{ query: string; variables: Record<string, unknown> }> }> {
  const subscribed: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
      else if (msg.type === 'subscribe') {
        subscribed.push(msg.payload);
        for (const spend of spends) ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { shieldedNullifierTransactions: spend } } }));
        if (complete) ws.send(JSON.stringify({ id: msg.id, type: 'complete' }));
      }
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const addr = wss.address();
  return { url: `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, subscribed };
}

describe('spendsOf', () => {
  it('finds none while the offer is live, asking from block 0 to the chain\'s tip', async () => {
    http = await startLocalIndexer(() => JSON.stringify({ data: { block: { height: 812 } } }));
    const ws = await subscriptions([]);

    expect(await spendsOf({ indexer: http.url, indexerWS: ws.url }, [N1, N2])).toEqual([]);
    expect(ws.subscribed).toHaveLength(1);
    expect(ws.subscribed[0]!.variables).toEqual({ prefixes: [N1, N2], fromBlock: 0, toBlock: 812 });
  });

  it('returns the exact spends of the offer\'s coins, not a coin that only shares a prefix', async () => {
    http = await startLocalIndexer(() => JSON.stringify({ data: { block: { height: 900 } } }));
    const taken = { nullifier: N2, transactionHash: 'cd'.repeat(32), blockHeight: 899 };
    const ws = await subscriptions([{ nullifier: 'bb'.repeat(31) + 'cc', transactionHash: 'ef'.repeat(32), blockHeight: 10 }, taken]);

    expect(await spendsOf({ indexer: http.url, indexerWS: ws.url }, [N1, N2])).toEqual([taken]);
  });

  it('says it can\'t tell when the indexer has no blocks yet', async () => {
    http = await startLocalIndexer(() => JSON.stringify({ data: { block: null } }));
    const ws = await subscriptions([]);

    await expect(spendsOf({ indexer: http.url, indexerWS: ws.url }, [N1])).rejects.toBeInstanceOf(LivenessUnknownError);
    expect(ws.subscribed).toEqual([]);
  });

  it('says it can\'t tell when the indexer drops the check part way through', async () => {
    http = await startLocalIndexer(() => JSON.stringify({ data: { block: { height: 5 } } }));
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    servers.push(wss);
    wss.on('connection', (ws) => ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
      else if (msg.type === 'subscribe') {
        ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { shieldedNullifierTransactions: { nullifier: N1, transactionHash: 'ab'.repeat(32), blockHeight: 3 } } } }));
        ws.close();
      }
    }));
    await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
    const addr = wss.address();

    await expect(spendsOf({ indexer: http.url, indexerWS: `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }, [N1]))
      .rejects.toThrow("Can't tell whether the offer is still live");
  });
});
