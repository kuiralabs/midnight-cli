// transfer command — send NIGHT from my wallet to other addresses, in one transaction
// Usage: midnight transfer <to> <amount> [<to> <amount> ...] [--to-file <file>] [--shielded]

import { type ParsedArgs, hasFlag, rejectNoCacheForWrites, networkChoiceFromArgs, nightAmountJson, nightAmountText, shieldedSyncEnabled, type CallContext } from '@kuiralabs/midnight-cli-core';
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
  // A transfer to the sending wallet itself goes through (it only pays a fee): warned, not refused, for each recipient that is.
  let toSelf: boolean[] = request.recipients.map(() => false);
  try {
    const result = await transferNight(ctx.host, { wallet: request.walletPath }, {
      ...networkChoiceFromArgs(args),
      ...(request.recipients.length === 1
        ? { recipient: request.recipients[0]!.address, amount: request.recipients[0]!.amount }
        : { recipients: request.recipients.map(({ address, amount }) => ({ recipient: address, amount })) }),
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
        toSelf = request.recipients.map(({ address }) => isOwnAddress(event, address));
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

/** What a transfer to several recipients says when one or more of them (selfTransfer) is the sending wallet itself. */
const SELF_RECIPIENT_NOTE = 'A recipient marked selfTransfer is this wallet itself: the NIGHT paid to it stays in it.';

/** Whether `recipient` is the opened wallet's own address on the network, unshielded or shielded. */
function isOwnAddress(opened: WalletOpened, recipient: string): boolean {
  return recipient === opened.address || (opened.shieldedAddress !== undefined && recipient === opened.shieldedAddress);
}

/** Heads the output once the wallet is open: what goes where, before the wallet syncs. */
function printHeading(opened: WalletOpened, { recipients, total, shielded }: TransferRequest, toSelf: readonly boolean[], ctx: CallContext): void {
  const unit = shielded ? ' NIGHT (shielded)' : ' NIGHT';
  ctx.output.stderr('\n' + header(shielded ? 'Shielded Transfer' : 'Transfer') + '\n\n');
  ctx.output.stderr(keyValue('Network', opened.network) + '\n');
  if (!shielded) ctx.output.stderr(keyValue('From', formatAddress(opened.address, true)) + '\n');
  if (recipients.length === 1) {
    ctx.output.stderr(keyValue('To', formatAddress(recipients[0]!.address, true)) + '\n');
    ctx.output.stderr(keyValue('Amount', bold(nightAmountText(total) + unit)) + '\n');
    if (toSelf[0]) ctx.output.stderr('\n' + yellow(`  Warning: ${SELF_TRANSFER_NOTE}`) + '\n');
    ctx.output.stderr('\n');
    return;
  }
  ctx.output.stderr(keyValue('To', `${recipients.length} recipients`) + '\n');
  // One column of recipients, and their amounts lined up on the decimal point.
  const rows = recipients.map(({ input, address, amount }) => {
    const [whole, fraction] = nightAmountText(amount).split('.') as [string, string | undefined];
    return { address, named: input === address ? '' : ` (${input})`, whole, fraction: fraction === undefined ? '' : `.${fraction}` };
  });
  const nameWidth = Math.max(...rows.map((row) => row.named.length));
  const wholeWidth = Math.max(...rows.map((row) => row.whole.length));
  const fractionWidth = Math.max(...rows.map((row) => row.fraction.length));
  rows.forEach(({ address, named, whole, fraction }, index) => {
    const amount = whole.padStart(wholeWidth) + fraction.padEnd(fractionWidth);
    ctx.output.stderr(`    ${formatAddress(address, true)}${dim(named.padEnd(nameWidth))}  ${bold(amount)} NIGHT\n`);
    if (toSelf[index]) ctx.output.stderr(yellow(`      Warning: recipient ${index + 1} is this wallet itself: its NIGHT stays in it.`) + '\n');
  });
  ctx.output.stderr(keyValue('Total', bold(nightAmountText(total) + unit)) + '\n');
  ctx.output.stderr('\n');
}

function printTransfer({ network, txHash, receipt }: NightTransfer, { recipients, total, shielded }: TransferRequest, jsonMode: boolean, toSelf: readonly boolean[], ctx: CallContext): void {
  if (jsonMode) {
    // One recipient: today's fields exactly. Several: each in `recipients`, and `amount` their total.
    const paid = recipients.length === 1
      ? { recipient: recipients[0]!.address }
      : { recipients: recipients.map(({ address, amount }, index) => ({ recipient: address, amount: nightAmountJson(amount), ...(toSelf[index] ? { selfTransfer: true } : {}) })) };
    const self = recipients.length === 1
      ? (toSelf[0] ? { selfTransfer: true, note: SELF_TRANSFER_NOTE } : {})
      : (toSelf.some(Boolean) ? { note: SELF_RECIPIENT_NOTE } : {});
    ctx.output.result({
      txHash,
      amount: nightAmountJson(total),
      ...paid,
      network,
      ...(shielded ? { type: 'shielded' } : {}),
      ...self,
      ...(receipt ? receiptJson(receipt) : {}),
    });
    return;
  }

  const what = shielded ? 'shielded NIGHT' : 'NIGHT';
  const to = recipients.length === 1 ? '' : ` to ${recipients.length} recipients`;
  ctx.output.stdout(txHash + '\n');
  ctx.output.stderr('\n' + successMessage(`Transferred ${nightAmountText(total)} ${what}${to}`, txHash) + '\n');
  if (receipt) ctx.output.stderr(receiptText(receipt, txHash));
  ctx.output.stderr('\n' + divider() + '\n');
  // A wallet's own balance reads its shielded part, where shielded sync is on or forced.
  ctx.output.stderr(dim(`  Verify: midnight balance${shielded && !shieldedSyncEnabled(network) ? ' --force-shielded' : ''}`) + '\n\n');
}
