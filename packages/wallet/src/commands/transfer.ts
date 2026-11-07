// transfer command — send NIGHT from my wallet to another address
// Usage: midnight transfer <to> <amount> [--shielded]

import { type ParsedArgs, hasFlag, rejectNoCacheForWrites, networkChoiceFromArgs, nightAmountJson, nightAmountText, type CallContext } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, divider, formatAddress, successMessage, bold, dim, yellow, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { resolveTransferRequest, type TransferRequest } from '../lib/transfer-request.ts';
import { transferNight, type NightTransfer } from '../lib/wallet/transfer.ts';
import type { WalletOpened } from '../lib/wallet/wallet-call.ts';
import { receiptJson } from '@kuiralabs/midnight-chain';
import { receiptText } from '../ui/receipt.ts';

export default async function transferCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  const request = await resolveTransferRequest(args, ctx.config.paths.stateRoot, ctx.host);
  const jsonMode = hasFlag(args, 'json');
  // --json shows no step and no heading on the terminal.
  const progress = spinnerReporter(ctx.progress, jsonMode);
  // A transfer to the sending wallet itself goes through (it only pays a fee): warned, not refused.
  let toSelf = false;
  try {
    const result = await transferNight(ctx.host, { wallet: request.walletPath }, {
      ...networkChoiceFromArgs(args),
      recipient: request.recipientAddress,
      amount: request.amount,
      shielded: request.shielded,
      forceShielded: hasFlag(args, 'force-shielded'),
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      sdkWarnings: ctx.sdkWarnings,
      onProgress: (event) => {
        if (event.kind !== 'wallet-opened') {
          progress.report(event);
          return;
        }
        toSelf = isOwnAddress(event, request.recipientAddress);
        if (!jsonMode) printHeading(event, request, toSelf, ctx);
      },
    });
    printTransfer(result, request, jsonMode, toSelf, ctx);
  } catch (err) {
    progress.fail('Failed');
    throw err;
  }
}

/** What a transfer to the sending wallet itself says. */
const SELF_TRANSFER_NOTE = 'The recipient is this wallet itself: the NIGHT stays in it, and the transfer only spends a fee.';

/** Whether `recipient` is the opened wallet's own address on the network, unshielded or shielded. */
function isOwnAddress(opened: WalletOpened, recipient: string): boolean {
  return recipient === opened.address || (opened.shieldedAddress !== undefined && recipient === opened.shieldedAddress);
}

/** Heads the output once the wallet is open: what goes where, before the wallet syncs. */
function printHeading(opened: WalletOpened, { recipientAddress, amount, shielded }: TransferRequest, toSelf: boolean, ctx: CallContext): void {
  const text = nightAmountText(amount);
  ctx.output.stderr('\n' + header(shielded ? 'Shielded Transfer' : 'Transfer') + '\n\n');
  ctx.output.stderr(keyValue('Network', opened.network) + '\n');
  if (!shielded) ctx.output.stderr(keyValue('From', formatAddress(opened.address, true)) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipientAddress, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(text + (shielded ? ' NIGHT (shielded)' : ' NIGHT'))) + '\n');
  if (toSelf) ctx.output.stderr('\n' + yellow(`  Warning: ${SELF_TRANSFER_NOTE}`) + '\n');
  ctx.output.stderr('\n');
}

function printTransfer({ network, txHash, receipt }: NightTransfer, { recipientAddress, amount, shielded }: TransferRequest, jsonMode: boolean, toSelf: boolean, ctx: CallContext): void {
  if (jsonMode) {
    ctx.output.result({
      txHash,
      amount: nightAmountJson(amount),
      recipient: recipientAddress,
      network,
      ...(shielded ? { type: 'shielded' } : {}),
      ...(toSelf ? { selfTransfer: true, note: SELF_TRANSFER_NOTE } : {}),
      ...(receipt ? receiptJson(receipt) : {}),
    });
    return;
  }

  ctx.output.stdout(txHash + '\n');
  ctx.output.stderr('\n' + successMessage(`Transferred ${nightAmountText(amount)} ${shielded ? 'shielded NIGHT' : 'NIGHT'}`, txHash) + '\n');
  if (receipt) ctx.output.stderr(receiptText(receipt, txHash));
  ctx.output.stderr('\n' + divider() + '\n');
  ctx.output.stderr(dim(shielded ? '  Verify: midnight balance --shielded' : '  Verify: midnight balance') + '\n\n');
}
