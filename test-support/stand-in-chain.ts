// A chain's three endpoints on 127.0.0.1, standing in for a localnet: an indexer
// serving a ledger-9 localnet's latest block (its protocol version and ledger
// parameters, which a deploy or call prices with), a node that accepts a
// WebSocket, and a proof server that answers /version. Enough for the checks a
// command makes before its payer is asked, and nothing past them: a test that
// points at a real chain's ports passes only where that chain happens to run.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { LEDGER9_PARAMETERS_HEX } from './fixtures/ledger9-parameters.ts';

export interface StandInChain {
  readonly node: string;
  readonly indexerWS: string;
  readonly proofServer: string;
  /** The GraphQL requests the indexer was sent, parsed. */
  readonly indexerRequests: Array<{ query: string; variables?: Record<string, unknown> }>;
  close(): Promise<void>;
}

const LATEST_BLOCK = JSON.stringify({ data: { block: { height: 26919, protocolVersion: 2001000, ledgerParameters: LEDGER9_PARAMETERS_HEX } } });

async function listening(server: Server | WebSocketServer): Promise<number> {
  if (server instanceof WebSocketServer) {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  } else {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  return (server.address() as AddressInfo).port;
}

export async function startStandInChain(): Promise<StandInChain> {
  const indexerRequests: StandInChain['indexerRequests'] = [];
  const indexer = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      indexerRequests.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(LATEST_BLOCK);
    });
  });
  const proofServer = createServer((req, res) => {
    if (req.url === '/version') res.end('8.1.0');
    else { res.statusCode = 404; res.end(); }
  });
  const node = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const [indexerPort, proofServerPort, nodePort] = await Promise.all([listening(indexer), listening(proofServer), listening(node)]);
  return {
    node: `ws://127.0.0.1:${nodePort}`,
    indexerWS: `ws://127.0.0.1:${indexerPort}/api/v4/graphql/ws`,
    proofServer: `http://127.0.0.1:${proofServerPort}`,
    indexerRequests,
    close: async () => {
      for (const client of node.clients) client.terminate();
      indexer.closeAllConnections();
      proofServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => indexer.close(() => resolve())),
        new Promise<void>((resolve) => proofServer.close(() => resolve())),
        new Promise<void>((resolve) => node.close(() => resolve())),
      ]);
    },
  };
}
