// dust command — register UTXOs for dust generation, check status, export a snapshot
// Usage: midnight dust register | midnight dust status | midnight dust export


import { type ParsedArgs, getFlag, hasFlag, isMinimalMode, rejectNoCacheForWrites, UsageError, networkChoiceFromArgs, type ProgressEvent, type DustExportResult, type CallContext } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, divider, formatDust, successMessage, toDust, bold, dim, yellow, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { walletSourceOf } from '../lib/seed-resolver.ts';
import { exportDustSnapshot, readDustStatus, registerDust, type DustRegistrationResult, type DustStatus } from '../lib/wallet/dust.ts';
import type { WalletOpened } from '../lib/wallet/wallet-call.ts';

import { receiptJson } from '@kuiralabs/midnight-chain';
import { receiptText } from '../ui/receipt.ts';

export default async function dustCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || (subcommand !== 'register' && subcommand !== 'status' && subcommand !== 'export')) {
    throw new UsageError(
      'Missing or invalid subcommand.\n' +
      'Usage:\n' +
      '  midnight dust register   Register NIGHT UTXOs for dust generation\n' +
      '  midnight dust status     Check dust registration status\n' +
      '  midnight dust export     Export a restorable dust snapshot (dustSerializedState)'
    );
  }

  const isJson = hasFlag(args, 'json');
  const minimal = isMinimalMode(args);
  // The network (--network flag / config / fallback) and its endpoints (--flag > config > network default).
  const call = { ...networkChoiceFromArgs(args), signal: ctx.signal, log: ctx.diagnostics.line, sdkWarnings: ctx.sdkWarnings };
  // --json shows no step and no heading on the terminal.
  const progress = spinnerReporter(ctx.progress, isJson);

  try {
    // export: accepts a raw --seed (so a dApp operator can export a snapshot for its
    // own seed with no named wallet) or falls back to a named wallet.
    if (subcommand === 'export') {
      const result = await exportDustSnapshot(ctx.host, walletSourceOf(args, ctx.config.settings), { ...call, onProgress: progress.report });
      printExport(result, isJson, minimal, ctx);
      return;
    }

    // status / register: a named wallet, the active one when none is given.
    const wallet = { wallet: getFlag(args, 'wallet') };
    if (subcommand === 'status') {
      const status = await readDustStatus(ctx.host, wallet, { ...call, forceFresh: hasFlag(args, 'no-cache'), onProgress: headed('Dust Status', progress.report, isJson, ctx) });
      printStatus(status, isJson, minimal, ctx);
      return;
    }

    // register: the full wallet flow (proof server, keystore, sync); writes always use the cache.
    rejectNoCacheForWrites(args);
    const registration = await registerDust(ctx.host, wallet, { ...call, onProgress: headed('Dust Register', progress.report, isJson, ctx) });
    printRegistration(registration, isJson, ctx);
  } catch (err) {
    progress.fail('Failed');
    throw err;
  }
}

/** Shows each step, and heads the output with `title` and the network once the wallet is open (not under --json). */
function headed(title: string, report: (event: ProgressEvent) => void, jsonMode: boolean, ctx: CallContext): (event: ProgressEvent | WalletOpened) => void {
  return (event) => {
    if (event.kind !== 'wallet-opened') {
      report(event);
      return;
    }
    if (jsonMode) return;
    ctx.output.stderr('\n' + header(title) + '\n\n');
    ctx.output.stderr(keyValue('Network', event.network) + '\n\n');
  };
}

// export: the snapshot (the pipeable data) goes to stdout; a summary goes to stderr; --json bundles it all.
function printExport(result: DustExportResult, jsonMode: boolean, minimal: boolean, ctx: CallContext): void {
  if (jsonMode) {
    ctx.output.result({
      subcommand: 'export',
      network: result.network,
      dustPublicKey: result.dustPublicKey,
      offset: result.offset,
      dustBalance: toDust(result.balance),
      eventCount: result.eventCount,
      fromCache: result.fromCache,
      partial: result.partial,
      snapshot: result.snapshot,
    });
    return;
  }

  ctx.output.stdout(result.snapshot + '\n');
  if (minimal) return;
  ctx.output.stderr('\n' + keyValue('Network', result.network) + '\n');
  ctx.output.stderr(keyValue('Dust balance', formatDust(result.balance)) + '\n');
  ctx.output.stderr(keyValue('Snapshot offset', String(result.offset)) + '\n');
  if (result.partial) {
    // Loud, because a partial snapshot restores without error and then quietly
    // hands the remaining events back to the SDK's cold sync — the exact failure
    // this command exists to prevent.
    ctx.output.stderr(
      '\n' + yellow(bold('⚠ Snapshot is INCOMPLETE — the sync did not reach the chain tip.')) + '\n' +
      dim('  Restoring it still beats a cold start, but the wallet has events left to catch up on.') + '\n' +
      dim('  Re-run `mn dust export` to resume from this checkpoint and finish.') + '\n',
    );
  }
  ctx.output.stderr('\n' + dim('Restore with the wallet SDK dustSerializedState to skip the cold dust sync.') + '\n');
}

function printStatus(status: DustStatus, jsonMode: boolean, minimal: boolean, ctx: CallContext): void {
  const { network: networkName, registeredUtxos, unregisteredUtxos } = status;

  // Not registered: the Dust was not read.
  if (!status.registered) {
    const totalUtxos = registeredUtxos + unregisteredUtxos;

    if (jsonMode) {
      if (minimal) {
        ctx.output.result({
          network: networkName,
          registered: false,
          registeredUtxos,
          unregisteredUtxos,
        });
        return;
      }
      ctx.output.result({
        subcommand: 'status',
        registered: false,
        registeredUtxos,
        unregisteredUtxos,
        network: networkName,
      });
      return;
    }

    // Machine-readable to stdout
    ctx.output.stdout('registered=no\n');
    ctx.output.stdout(`registered_utxos=${registeredUtxos}\n`);
    ctx.output.stdout(`unregistered_utxos=${unregisteredUtxos}\n`);

    // Formatted to stderr
    ctx.output.stderr(keyValue('Registered', bold('no')) + '\n');
    ctx.output.stderr(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');

    if (totalUtxos === 0) {
      ctx.output.stderr('\n' + dim('No NIGHT UTXOs at this address. Fund the wallet first.') + '\n');
    } else {
      ctx.output.stderr('\n' + dim('Not generating dust. Run: midnight dust register') + '\n');
    }

    ctx.output.stderr('\n' + divider() + '\n\n');
    return;
  }

  const dustAvailable = status.availableCoins > 0;
  if (jsonMode) {
    // Slim drops eventsApplied/ownedUtxos/cached/subcommand — internal
    // sync details an agent doesn't need to act on.
    if (minimal) {
      ctx.output.result({
        network: networkName,
        registered: true,
        registeredUtxos,
        unregisteredUtxos,
        dustBalance: toDust(status.dust),
        dustAvailable,
      });
      return;
    }
    ctx.output.result({
      subcommand: 'status',
      registered: true,
      registeredUtxos,
      unregisteredUtxos,
      dustBalance: toDust(status.dust),
      dustAvailable,
      eventsApplied: status.eventsApplied,
      ownedUtxos: status.ownedUtxos,
      cached: status.fromCache,
      network: networkName,
    });
    return;
  }

  // Machine-readable to stdout
  ctx.output.stdout('registered=yes\n');
  ctx.output.stdout(`dust=${toDust(status.dust)}\n`);
  ctx.output.stdout(`registered_utxos=${registeredUtxos}\n`);
  ctx.output.stdout(`unregistered_utxos=${unregisteredUtxos}\n`);

  // Formatted to stderr
  ctx.output.stderr(keyValue('Registered', bold('yes')) + '\n');
  ctx.output.stderr(keyValue('UTXOs', `${registeredUtxos} registered, ${unregisteredUtxos} unregistered`) + '\n');
  ctx.output.stderr(keyValue('Dust Balance', bold(formatDust(status.dust))) + '\n');
  ctx.output.stderr(keyValue('Dust Available', dustAvailable ? 'yes' : 'no') + '\n');
  ctx.output.stderr(keyValue('Events applied', status.eventsApplied.toString() + (status.fromCache ? ' (delta)' : '')) + '\n');
  if (unregisteredUtxos > 0) {
    ctx.output.stderr('\n' + dim(`${unregisteredUtxos} UTXO(s) not yet registered. Run: midnight dust register`) + '\n');
  }
  ctx.output.stderr('\n' + divider() + '\n\n');
}

function printRegistration(result: DustRegistrationResult, jsonMode: boolean, ctx: CallContext): void {
  const { network, dust, txHash, receipt } = result;
  if (jsonMode) {
    const json: Record<string, unknown> = { subcommand: 'register', network, dustBalance: toDust(dust) };
    if (txHash) json.txHash = txHash;
    if (receipt) Object.assign(json, receiptJson(receipt));
    ctx.output.result(json);
    return;
  }

  // Machine-readable to stdout, as status gives it: the Dust in DUST, and the registration's identifier when one was sent.
  ctx.output.stdout(`dust=${toDust(dust)}\n`);
  if (txHash) ctx.output.stdout(`tx_hash=${txHash}\n`);
  ctx.output.stderr('\n' + successMessage(
    result.alreadyAvailable
      ? `Dust tokens already available: ${formatDust(dust)}`
      : `Dust tokens available: ${formatDust(dust)}`,
  ) + '\n');
  ctx.output.stderr((receipt && txHash ? receiptText(receipt, txHash) : '') + '\n');
}
