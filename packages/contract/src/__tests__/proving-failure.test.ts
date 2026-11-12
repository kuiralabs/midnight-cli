// A contract script's failed proof, carried out of the script and named: a
// proof server that dropped the connection mid-proof is NETWORK_ERROR naming it
// and the circuit, not UNKNOWN "proveTx rejected the transaction". The proof
// server is an external service: a local HTTP server answers its /version.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ContractScriptError, scriptFailureOf, SCRIPT_ERROR_MARKER } from '../lib/contract/runner.ts';
import { namingProofServer, provingFailureOf } from '../lib/contract/proving-failure.ts';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

async function proofServer(): Promise<string> {
  const server = createServer((req, res) => { res.writeHead(200); res.end(req.url === '/version' ? '9.0.0' : '{"status":"ok"}'); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** midnight-js's report of a proof whose connection dropped, as the script meets it. */
function droppedProof(url: string): Error {
  return Object.assign(new Error("proveTx rejected the transaction (circuit 'increment'). The provider's own failure is on `cause`"), {
    name: 'ProviderFailedError', method: 'proveTx', circuitId: 'increment',
    cause: new Error(`ProofServerError: Proof Server request failed: url="${url}/prove"`, { cause: new Error(`FetchError: request to ${url}/prove failed, reason: socket hang up\n    at ClientRequest.<anonymous>`) }),
  });
}

describe('a contract script\'s failed proof', () => {
  it('is carried out of the script with its circuit and what the proof provider said, first lines only', () => {
    expect(provingFailureOf(droppedProof('http://p'))).toEqual({
      circuit: 'increment',
      causes: ['ProofServerError: Proof Server request failed: url="http://p/prove"', 'FetchError: request to http://p/prove failed, reason: socket hang up'],
    });
    expect(provingFailureOf(new Error('anything else'))).toBeUndefined();
  });

  it('is read back from the script\'s report', () => {
    const report = { message: "proveTx rejected the transaction (circuit 'increment').", proving: { circuit: 'increment', causes: ['FetchError: socket hang up'] } };
    expect(scriptFailureOf(`progress\n${SCRIPT_ERROR_MARKER} ${JSON.stringify(report)}\n`, 1)).toEqual(report);
  });

  it('is NETWORK_ERROR naming the proof server and the circuit when the connection dropped and the proof server answers again', async () => {
    const url = await proofServer();
    const failure = new ContractScriptError({ message: "proveTx rejected the transaction (circuit 'increment').", proving: provingFailureOf(droppedProof(url))! });
    const named = await namingProofServer(failure, url);
    expect(named).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`The proof server at ${url} dropped the connection while proving circuit 'increment'`) });
  });

  it('leaves a failure that is not a proof as it is', async () => {
    const failure = new ContractScriptError({ message: 'boom' });
    expect(await namingProofServer(failure, 'http://127.0.0.1:1')).toBe(failure);
  });
});
