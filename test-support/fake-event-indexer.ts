// Minimal in-process indexer for the direct readers and the wallet SDK's
// syncs: speaks the graphql-transport-ws handshake and, for each subscription,
// replays the events of the stream the query names (`zswapLedgerEvents`,
// `dustLedgerEvents`, `unshieldedTransactions`) from the subscription's start
// id; a subscription to a stream it doesn't serve is refused, as an indexer
// refuses a field it lacks. Stubs the external indexer boundary only — the
// readers and wallets under test are real. It records each subscription it
// takes, and leaves the socket open: a reader finishes when it sees
// id >= maxId, or goes idle.

import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/** A subscription the fake indexer took: the query and its variables as sent. */
export interface TakenSubscription {
  query: string;
  variables: Record<string, unknown> | undefined;
}

export interface FakeEventIndexer {
  url: string;
  subscriptions: TakenSubscription[];
  close: () => Promise<void>;
}

/** The streams an indexer serves, and their events; an event with an `id` is sent from the subscription's start id on. */
export type FakeStreams = Partial<Record<'zswapLedgerEvents' | 'dustLedgerEvents' | 'unshieldedTransactions', ReadonlyArray<object>>>;

/** An indexer serving one ledger event stream. */
export function startFakeEventIndexer(
  field: 'zswapLedgerEvents' | 'dustLedgerEvents',
  events: ReadonlyArray<{ id: number }>,
): Promise<FakeEventIndexer> {
  return startFakeChainIndexer({ [field]: events });
}

/** An indexer serving each of `streams`. */
export function startFakeChainIndexer(streams: FakeStreams): Promise<FakeEventIndexer> {
  const subscriptions: TakenSubscription[] = [];
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, handleProtocols: () => 'graphql-transport-ws' });
    wss.on('connection', (socket: WsSocket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connection_init') {
          socket.send(JSON.stringify({ type: 'connection_ack' }));
          return;
        }
        if (msg.type === 'subscribe') {
          subscriptions.push({ query: msg.payload?.query, variables: msg.payload?.variables });
          const query = String(msg.payload?.query ?? '');
          const field = (Object.keys(streams) as (keyof FakeStreams)[]).find((name) => query.includes(`${name}(`));
          if (field === undefined) {
            socket.send(JSON.stringify({ id: msg.id, type: 'error', payload: [{ message: `This indexer serves ${Object.keys(streams).join(', ')} only` }] }));
            return;
          }
          const startId: number = msg.payload?.variables?.id ?? 0;
          for (const e of streams[field]!) {
            const id = (e as { id?: unknown }).id;
            if (typeof id === 'number' && id < startId) continue;
            socket.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { [field]: e } } }));
          }
        }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        subscriptions,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}
