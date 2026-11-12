// How long a call waits for a proof and a submit, and what a cut-short one says.

import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { CancelledError, NetworkError, ProofTimeoutError, SyncTimeoutError } from '../lib/errors.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { PROVE_TICK_MS, proveWithin, submitWithin } from '../lib/submit-wait.ts';

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const TX = '00'.repeat(33);

describe('submitWithin', () => {
  it('gives what the submit gives', async () => {
    await expect(submitWithin(Promise.resolve('hash'), { txId: TX, timeoutMs: 1_000 })).resolves.toBe('hash');
  });

  it('stops waiting on a submit that never returns: SYNC_TIMEOUT, saying it may still land and how to check', async () => {
    const failure = submitWithin(never<string>(), { txId: TX, timeoutMs: 50 });
    await expect(failure).rejects.toBeInstanceOf(SyncTimeoutError);
    await expect(failure).rejects.toThrow(`The node did not confirm the transaction within 0 s: it was sent and may still land. Check with: midnight tx status ${TX}`);
  });

  it('cancelled: CANCELLED at once, saying the transaction may still land', async () => {
    const controller = new AbortController();
    const failure = submitWithin(never<string>(), { txId: TX, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(failure).rejects.toBeInstanceOf(CancelledError);
    await expect(failure).rejects.toThrow(`Cancelled while the transaction was being submitted: it was sent and may still land. Check with: midnight tx status ${TX}`);
  });
});

describe('submitWithin, with the node it submits to', () => {
  it('stops waiting once the node stops answering: NETWORK_ERROR naming it, saying the transaction may still land', async () => {
    const node = `ws://127.0.0.1:${await closedPort()}`;
    const started = Date.now();
    const failure = submitWithin(never<string>(), { txId: TX, node, nodeCheckMs: 100, timeoutMs: 60_000 });
    await expect(failure).rejects.toBeInstanceOf(NetworkError);
    await expect(failure).rejects.toThrow(`The node at ${node} stopped answering while the transaction was submitted: it may have been sent and may still land. Check with: midnight tx status ${TX}`);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('keeps waiting while the node answers', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const node = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const landing = new Promise<string>((resolve) => setTimeout(() => resolve('hash'), 600));
      await expect(submitWithin(landing, { node, nodeCheckMs: 100, timeoutMs: 60_000 })).resolves.toBe('hash');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('proveWithin', () => {
  it('times out with PROOF_TIMEOUT, and stops at once with CANCELLED when cancelled', async () => {
    await expect(proveWithin(never(), 50)).rejects.toBeInstanceOf(ProofTimeoutError);
    await expect(proveWithin(never(), 60_000, AbortSignal.abort())).rejects.toBeInstanceOf(CancelledError);
  });

  it('names the proof server, what to check and that nothing was sent when it times out', async () => {
    await expect(proveWithin(never(), 50, undefined, { proofServer: 'http://127.0.0.1:6300' })).rejects.toMatchObject({
      code: 'PROOF_TIMEOUT',
      message: 'The proof server at http://127.0.0.1:6300 did not finish the proof within 0 s, so mn stopped waiting; nothing was sent.\n'
        + 'Check that it is running and not starved of CPU or memory (its logs, docker stats on its container), then run the command again.',
    });
  });

  it('says how long it has been proving while it waits, and stops saying it once the proof is done', async () => {
    vi.useFakeTimers();
    try {
      const ticks: number[] = [];
      let finish!: (value: string) => void;
      const proving = proveWithin(new Promise<string>((resolve) => { finish = resolve; }), 60_000, undefined, { onTick: (elapsedMs) => ticks.push(elapsedMs) });
      await vi.advanceTimersByTimeAsync(PROVE_TICK_MS * 3);
      finish('proven');
      await expect(proving).resolves.toBe('proven');
      await vi.advanceTimersByTimeAsync(PROVE_TICK_MS * 3);
      expect(ticks).toEqual([PROVE_TICK_MS, PROVE_TICK_MS * 2, PROVE_TICK_MS * 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});
