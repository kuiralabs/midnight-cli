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

import { LOCAL_WALLET_FUNDING_NIGHT, type ParsedArgs, getFlag, hasFlag, looksLikeShieldedAddress, looksLikeUnshieldedAddress, rejectNoCacheForWrites, networkChoiceFromArgs, nightAmountJson, nightAmountText, nightToMicro, parseAmount, type CallContext } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, divider, formatAddress, successMessage, bold, dim, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { airdropNight, type AirdropAddressed, type AirdropRecipient, type NightAirdrop } from '../lib/wallet/airdrop.ts';
import { receiptJson } from '@kuiralabs/midnight-chain';
import { receiptText } from '../ui/receipt.ts';

export default async function airdropCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  rejectNoCacheForWrites(args);
  // No amount: what mn funds its own local wallets with, whose Dust pays a
  // deploy's fee without waiting once registered (LOCAL_WALLET_FUNDING_NIGHT).
  const amount = args.subcommand ? parseAmount(args.subcommand) : nightToMicro(LOCAL_WALLET_FUNDING_NIGHT);
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
    printAirdrop(result, amount, jsonMode, getFlag(args, 'wallet'), ctx);
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

/**
 * The command that registers the airdropped wallet's NIGHT for Dust, which an
 * airdrop to a wallet not registered yet suggests. Suggested, not run:
 * registering is a transaction of the wallet's own, which needs its seed (and
 * so the passphrase an airdrop doesn't ask for), and an airdrop to a bare
 * address has no wallet file to take it from.
 */
export function registerDustCommand(walletFlag: string | undefined): string {
  if (walletFlag === undefined) return 'midnight dust register';
  return looksLikeUnshieldedAddress(walletFlag) ? 'midnight dust register --wallet <the wallet that owns this address>' : `midnight dust register --wallet ${walletFlag}`;
}

function printAirdrop({ network, txHash, recipient, shielded, receipt, dustRegistered }: NightAirdrop, amount: bigint, jsonMode: boolean, walletFlag: string | undefined, ctx: CallContext): void {
  const receiptFields = receipt ? receiptJson(receipt) : {};
  // Under --json, in the result's warnings.
  if (jsonMode && dustRegistered === false) ctx.warn(`This wallet's NIGHT isn't registered for Dust generation, so it can't pay a fee yet. Register it: ${registerDustCommand(walletFlag)}`);
  if (jsonMode) {
    ctx.output.result(shielded
      // recipient, as a transfer names it; shieldedAddress, its older name here, kept for the consumers that read it.
      ? { txHash, amount: nightAmountJson(amount), recipient, shieldedAddress: recipient, network, type: 'shielded', ...receiptFields }
      : { txHash, amount: nightAmountJson(amount), recipient, network, ...receiptFields, ...(dustRegistered === undefined ? {} : { dustRegistered }) });
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
  // A registered wallet's new NIGHT generates Dust with the rest: nothing to do.
  if (dustRegistered === true) {
    ctx.output.stderr(dim('  Dust:           already registered; this NIGHT generates Dust with the rest') + '\n\n');
    return;
  }
  ctx.output.stderr(dim(`  Register dust:  ${registerDustCommand(walletFlag)}`) + (dustRegistered === false ? dim('   (not registered yet: it can\'t pay a fee until it is)') : '') + '\n');
  ctx.output.stderr(dim('  Note: registering pays its fee from Dust this NIGHT generates, so it waits longer the less NIGHT')
    + '\n' + dim(`        there is (about a minute for 1000 NIGHT, none for ${LOCAL_WALLET_FUNDING_NIGHT}). dust register says how long.`) + '\n\n');
}
