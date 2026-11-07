// airdrop command — fund wallet from genesis wallet (seed 0x01)
// Only works on undeployed network (local devnet)
// --shielded: sends shielded NIGHT from genesis shielded balance
//
// `--wallet` accepts three forms:
//   1. a wallet name (resolved from ~/.midnight/wallets/<name>.json)
//   2. a path to a wallet JSON
//   3. a raw bech32m address (mn_addr_… or mn_shield-addr_…) — no wallet
//      file required, useful for funding externally-generated addresses.
//      A shielded address implies --shielded; the flag is optional there.

import { UsageError, type ParsedArgs, getFlag, hasFlag, looksLikeShieldedAddress, looksLikeUnshieldedAddress, rejectNoCacheForWrites, networkChoiceFromArgs, nightAmountJson, nightAmountText, parseAmount, type CallContext } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, divider, formatAddress, successMessage, bold, dim, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { airdropNight, type AirdropAddressed, type AirdropRecipient, type NightAirdrop } from '../lib/wallet/airdrop.ts';
import { receiptJson } from '@kuiralabs/midnight-chain';
import { receiptText } from '../ui/receipt.ts';

export default async function airdropCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  const amountStr = args.subcommand;
  if (!amountStr) {
    throw new UsageError(
      'Missing amount.\n' +
      'Usage: midnight airdrop <amount> [--wallet <name|file|address>]\n' +
      'Example: midnight airdrop 1000\n' +
      'Example: midnight airdrop 1000 --wallet alice\n' +
      'Example: midnight airdrop 1000 --wallet mn_addr_undeployed1...'
    );
  }

  const amount = parseAmount(amountStr);
  const jsonMode = hasFlag(args, 'json');
  // --json shows no step and no heading on the terminal.
  const progress = spinnerReporter(ctx.progress, jsonMode);
  try {
    const result = await airdropNight(ctx.host, {
      ...networkChoiceFromArgs(args),
      to: recipientOf(getFlag(args, 'wallet')),
      amount,
      shielded: hasFlag(args, 'shielded'),
      signal: ctx.signal,
      log: ctx.diagnostics.line,
      sdkWarnings: ctx.sdkWarnings,
      onProgress: (event) => {
        if (event.kind !== 'airdrop-addressed') progress.report(event);
        else if (!jsonMode) printHeading(event, amount, ctx);
      },
    });
    printAirdrop(result, amount, jsonMode, ctx);
  } catch (err) {
    progress.fail('Failed');
    throw err;
  }
}

/** `--wallet`: a bech32m address is funded as given; anything else names a wallet file (absent: the active wallet). */
function recipientOf(walletFlag: string | undefined): AirdropRecipient {
  return walletFlag !== undefined && (looksLikeUnshieldedAddress(walletFlag) || looksLikeShieldedAddress(walletFlag))
    ? { address: walletFlag }
    : { wallet: walletFlag };
}

/** Heads the output once the recipient is known, before the genesis wallet syncs. */
function printHeading({ network, recipient, shielded }: AirdropAddressed, amount: bigint, ctx: CallContext): void {
  ctx.output.stderr('\n' + header(shielded ? 'Shielded Airdrop' : 'Airdrop') + '\n\n');
  ctx.output.stderr(keyValue('Network', network) + '\n');
  ctx.output.stderr(keyValue('From', dim(shielded ? 'genesis shielded (seed 0x01)' : 'genesis (seed 0x01)')) + '\n');
  ctx.output.stderr(keyValue('To', formatAddress(recipient, true)) + '\n');
  ctx.output.stderr(keyValue('Amount', bold(nightAmountText(amount) + (shielded ? ' NIGHT (shielded)' : ' NIGHT'))) + '\n');
  ctx.output.stderr('\n');
}

function printAirdrop({ network, txHash, recipient, shielded, receipt }: NightAirdrop, amount: bigint, jsonMode: boolean, ctx: CallContext): void {
  const receiptFields = receipt ? receiptJson(receipt) : {};
  if (jsonMode) {
    ctx.output.result(shielded
      ? { txHash, amount: nightAmountJson(amount), shieldedAddress: recipient, network, type: 'shielded', ...receiptFields }
      : { txHash, amount: nightAmountJson(amount), recipient, network, ...receiptFields });
    return;
  }

  ctx.output.stdout(txHash + '\n');
  ctx.output.stderr('\n' + successMessage(`Airdropped ${nightAmountText(amount)} ${shielded ? 'shielded NIGHT' : 'NIGHT'} to your wallet`, txHash) + '\n');
  if (receipt) ctx.output.stderr(receiptText(receipt, txHash));
  ctx.output.stderr('\n' + divider() + '\n');
  if (shielded) {
    ctx.output.stderr(dim('  Verify: midnight balance --shielded') + '\n\n');
    return;
  }
  ctx.output.stderr(dim('  Verify:         midnight balance') + '\n');
  ctx.output.stderr(dim('  Register dust:  midnight dust register') + '\n');
  ctx.output.stderr(dim('  Note: registering pays its fee from Dust this NIGHT generates, so it waits longer the less NIGHT')
    + '\n' + dim('        there is (about a minute for 1000 NIGHT). dust register says how long.') + '\n\n');
}
