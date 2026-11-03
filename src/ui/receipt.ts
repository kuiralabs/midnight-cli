// A submitted transaction's receipt, as a command shows it on stderr.

import type { Receipt } from '@kuiralabs/midnight-chain/lib/tx-receipt';
import { keyValue, formatDust } from '@kuiralabs/midnight-cli-core/ui/format';
import { dim } from '@kuiralabs/midnight-cli-core/ui/colors';

/** The receipt's lines: block, fee and a result other than success; or why there is none yet. */
export function receiptText(receipt: Receipt, txId: string): string {
  if (!receipt.listed) {
    return dim(`  No receipt yet: ${receipt.reason}. Check with: midnight tx status ${txId}`) + '\n';
  }
  const tx = receipt.transaction;
  let text = keyValue('Block', `${tx.block.height} at ${tx.block.time.toISOString()}`) + '\n';
  if (tx.feeSpecks !== undefined) text += keyValue('Fee', formatDust(tx.feeSpecks)) + '\n';
  if (tx.result !== undefined && tx.result !== 'SUCCESS') text += keyValue('Result', tx.result) + '\n';
  return text;
}
