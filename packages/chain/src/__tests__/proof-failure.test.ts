// A failed proof, said as what it was: a proof server out of reach, or one that refused.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EndpointUnreachableError, ProofFailureError, ProofServerDroppedError, NetworkError } from '@kuiralabs/midnight-cli-core';
import { explainProofFailure } from '../lib/proof-failure.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

/** The SDK's shape: ProvingError over ClientError("Failed to prove transaction") over what happened. */
const sdkProofFailure = (inner: Error): ProofFailureError =>
  new ProofFailureError('Failed to prove transaction', { cause: Object.assign(new Error('Failed to prove transaction'), { cause: inner }) });

describe('explainProofFailure', () => {
  // A proof server that answers its /version as the 9.0.0 one does.
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });
  async function proofServer(): Promise<string> {
    const server = createServer((req, res) => { res.writeHead(200); res.end(req.url === '/version' ? '9.0.0' : '{"status":"ok"}'); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('names a proof server that can\'t be reached: NETWORK_ERROR, its URL and why', async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const explained = await explainProofFailure(sdkProofFailure(new Error('boom')), url);
    expect(explained).toBeInstanceOf(EndpointUnreachableError);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the proof server at ${url}: connection refused.`) });
  });

  it('says a proof server that dropped the connection mid-proof and answers again: NETWORK_ERROR, its URL, no cache advice', async () => {
    const url = await proofServer();
    const explained = await explainProofFailure(sdkProofFailure(new Error('Failed to connect to Proof Server: socket hang up')), url);
    expect(explained).toBeInstanceOf(ProofServerDroppedError);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`The proof server at ${url} dropped the connection while proving the transaction (socket hang up), and answers again now`) });
    expect((explained as Error).message).not.toContain('cache clear');
  });

  it('finds the dropped connection inside the Effect failure the SDK rejects with, as a transfer through a proof server that cut POST /prove did', async () => {
    // Measured: ProofFailureError > FiberFailure (its failure under a symbol, no cause) > ClientError > Error.
    const url = await proofServer();
    const inner = new Error(`'prove' returned an error: (FiberFailure) ClientError: Failed to connect to Proof Server: Transport error (POST ${url}/prove)\n    at Object.RequestError (file:///x/HttpProverClient.js:75:36)`);
    const clientError = new Error('Failed to prove transaction', { cause: inner });
    const fiberFailure = Object.assign(new Error('Failed to prove transaction'), { [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { _tag: 'Fail', error: clientError } });
    const explained = await explainProofFailure(new ProofFailureError('Failed to prove transaction', { cause: fiberFailure }), url);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`dropped the connection while proving the transaction (Transport error (POST ${url}/prove)), and answers again now`) });
    expect((explained as Error).message).not.toContain('HttpProverClient.js');
  });

  it('names the proof server and the circuit when midnight-js reports a proof whose connection dropped (an account contract\'s k256 circuit)', async () => {
    const url = await proofServer();
    const failed = Object.assign(new Error("proveTx rejected the transaction (circuit 'append_inbox_batch_with_k256'). The provider's own failure is on `cause`"), {
      name: 'ProviderFailedError', method: 'proveTx', circuitId: 'append_inbox_batch_with_k256',
      cause: new Error(`ProofServerError: Proof Server request failed: url="${url}/prove"`, { cause: new Error('FetchError: request to ' + url + '/prove failed, reason: socket hang up') }),
    });
    const explained = await explainProofFailure(failed, url);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', circuit: 'append_inbox_batch_with_k256', message: expect.stringContaining(`The proof server at ${url} dropped the connection while proving circuit 'append_inbox_batch_with_k256'`) });
  });

  it('names the circuit a proof server that died while proving it was proving, when it no longer answers', async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const failed = Object.assign(new Error("proveTx rejected the transaction (circuit 'issue_grant_with_k256')."), { name: 'ProviderFailedError', method: 'proveTx', circuitId: 'issue_grant_with_k256', cause: new Error('fetch failed') });
    const explained = await explainProofFailure(failed, url);
    expect(explained).toBeInstanceOf(EndpointUnreachableError);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the proof server at ${url}: connection refused; it stopped answering while proving circuit 'issue_grant_with_k256'.`) });
  });

  it('says a proof server that answers refused the proof: PROOF_FAILURE, its URL and what it said', async () => {
    const url = await proofServer();
    const explained = await explainProofFailure(sdkProofFailure(new Error('Failed to prove: bad input')), url);
    expect(explained).toBeInstanceOf(ProofFailureError);
    expect((explained as Error).message).toMatch(new RegExp(`^The proof server at ${url} refused to prove the transaction: Failed to prove: bad input\\.\\n`));
  });

  it('leaves any other error as it is', async () => {
    const other = new NetworkError('down');
    expect(await explainProofFailure(other, 'http://127.0.0.1:6300')).toBe(other);
  });
});
