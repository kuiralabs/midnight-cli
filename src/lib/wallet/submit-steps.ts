// What a wallet operation that pays says while the engine syncs, proves and
// submits, in the words mn has always shown, and its receipt after.

import type { ProgressSteps } from '@kuiralabs/midnight-cli-core/lib/progress';
import { type Receipt, receiptOf } from '@kuiralabs/midnight-chain/lib/tx-receipt';

/** Says a sync's progress as "`label`... N%", and "`label`..." once it reaches the tip. */
export function saySyncPercent(steps: ProgressSteps, label: string, applied: number, highest: number): void {
  if (highest > 0) {
    const pct = Math.min(Math.round((applied / highest) * 100), 100);
    steps.update(pct >= 100 ? `${label}...` : `${label}... ${pct}%`);
  }
}

/** The engine's proving and submitting hooks, said as steps: the submit's wait shows its elapsed time. */
export function submitSteps(steps: ProgressSteps): { onProving(): void; onSubmitting(): void; onSubmittingTick(elapsedMs: number): void } {
  return {
    onProving: () => steps.update('Generating ZK proof (this may take a few minutes)...'),
    onSubmitting: () => steps.update('Submitting and waiting for finalization (typically 12 to 30s)...'),
    onSubmittingTick: (elapsedMs) => {
      const s = Math.floor(elapsedMs / 1000);
      const mm = Math.floor(s / 60).toString().padStart(2, '0');
      const ss = (s % 60).toString().padStart(2, '0');
      steps.update(`Submitting and waiting for finalization... ${mm}:${ss} elapsed (typically 12 to 30s)`);
    },
  };
}

/**
 * The submitted transaction `txHash` once the indexer at `indexer` lists it,
 * or why it is missing; undefined, without asking, when `waitMs` is 0. Then
 * the step is done: "Transaction submitted".
 */
export async function receiptOfSubmitted(indexer: string, txHash: string, steps: ProgressSteps, signal: AbortSignal | undefined, waitMs: number): Promise<Receipt | undefined> {
  let receipt: Receipt | undefined;
  if (waitMs > 0) {
    steps.update('Waiting for the indexer to list it...');
    receipt = await receiptOf(indexer, txHash, signal, waitMs);
  }
  steps.done('Transaction submitted');
  return receipt;
}
