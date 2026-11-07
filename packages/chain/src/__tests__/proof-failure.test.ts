// A failed proof, said as what it was: a proof server out of reach, or one that refused.

import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EndpointUnreachableError, ProofFailureError, NetworkError } from '@kuiralabs/midnight-cli-core';
import { explainProofFailure } from '../lib/proof-failure.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

/** The SDK's shape: ProvingError over ClientError("Failed to prove transaction") over what happened. */
const sdkProofFailure = (inner: Error): ProofFailureError =>
  new ProofFailureError('Failed to prove transaction', { cause: Object.assign(new Error('Failed to prove transaction'), { cause: inner }) });

describe('explainProofFailure', () => {
  it('names a proof server that can\'t be reached: NETWORK_ERROR, its URL and why', async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    const explained = await explainProofFailure(sdkProofFailure(new Error('boom')), url);
    expect(explained).toBeInstanceOf(EndpointUnreachableError);
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`Cannot reach the proof server at ${url}: connection refused.`) });
  });

  it('names a proof server the SDK could not connect to, even when it answers now', async () => {
    const explained = await explainProofFailure(sdkProofFailure(new Error('Failed to connect to Proof Server: socket hang up')), 'http://127.0.0.1:6300');
    expect(explained).toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('Cannot reach the proof server at http://127.0.0.1:6300: socket hang up.') });
  });

  it('says a proof server that answers refused the proof: PROOF_FAILURE, its URL and what it said', async () => {
    const server = createServer((_req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const explained = await explainProofFailure(sdkProofFailure(new Error('Failed to prove: bad input')), url);
      expect(explained).toBeInstanceOf(ProofFailureError);
      expect((explained as Error).message).toMatch(new RegExp(`^The proof server at ${url} refused to prove the transaction: Failed to prove: bad input\\.\\n`));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('leaves any other error as it is', async () => {
    const other = new NetworkError('down');
    expect(await explainProofFailure(other, 'http://127.0.0.1:6300')).toBe(other);
  });
});
