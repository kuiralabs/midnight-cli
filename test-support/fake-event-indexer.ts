// Minimal in-process indexer for the direct readers: speaks the
// graphql-transport-ws handshake and replays a fixture's ledger events from the
// subscription's start id, under the subscription field the reader asks for
// (`zswapLedgerEvents` or `dustLedgerEvents`). Stubs the external indexer
// boundary only — the reader under test is real. It records each subscription
// it takes, and leaves the socket open: the reader finishes when it sees
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

export function startFakeEventIndexer(
  field: 'zswapLedgerEvents' | 'dustLedgerEvents',
  events: ReadonlyArray<{ id: number }>,
): Promise<FakeEventIndexer> {
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
          const startId: number = msg.payload?.variables?.id ?? 0;
          for (const e of events) {
            if (e.id < startId) continue;
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
