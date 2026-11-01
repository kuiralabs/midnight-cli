// Node readiness check — Docker healthy ≠ chain ready. Substrate nodes
// finish starting before they've produced block 1, so any command that
// depends on the chain (airdrop needing the genesis UTXO, for instance)
// can race ahead and see an empty chain. This helper polls chain_getHeader
// until a non-zero block number appears.

import { callNodeRpc } from './node-rpc.ts';
import { throwIfCancelled } from './errors.ts';
import { sleep } from './sleep.ts';

export interface WaitForFirstBlockOptions {
  /** Overall deadline for the wait. Default 30s. */
  timeoutMs?: number;
  /** How often to re-poll while waiting. Default 1s. */
  pollIntervalMs?: number;
  /** The call's cancellation: the wait stops with CancelledError. */
  signal?: AbortSignal;
}

/**
 * Poll `chain_getHeader` until the reported block number is >= 1.
 * Resolves as soon as a block exists; rejects on timeout, or with
 * CancelledError when the call is cancelled.
 */
export async function waitForFirstBlock(
  nodeWsUrl: string,
  opts: WaitForFirstBlockOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const header = await callNodeRpc<{ number?: unknown }>(
        { url: nodeWsUrl, timeoutMs: 3_000, signal: opts.signal },
        'chain_getHeader',
      );
      const hexNumber = typeof header?.number === 'string' ? header.number : '0x0';
      const blockNumber = Number.parseInt(hexNumber, 16);
      if (Number.isFinite(blockNumber) && blockNumber >= 1) return;
    } catch {
      throwIfCancelled(opts.signal);
      // Node not yet accepting connections — retry.
    }
    await sleep(pollIntervalMs, opts.signal);
  }

  throw new Error(`Node did not produce a block within ${timeoutMs / 1000}s`);
}
