// tx command: what became of a transaction, from the indexer
// Usage: midnight tx status <hash or identifier> [--wait [--timeout <seconds>]] [--network <name>] [--json]

import { type ParsedArgs, getFlag, hasFlag, UsageError, SyncTimeoutError, resolveNetwork, type CallContext } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, formatDust, dim, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { parseTxReference, transactionStatus, TX_STATUS_WAIT_MS } from '../lib/tx-status.ts';
import { transactionStatusJson } from '../lib/tx-receipt.ts';

function timeoutMsOf(args: ParsedArgs): number {
  const raw = getFlag(args, 'timeout');
  if (raw === undefined) return TX_STATUS_WAIT_MS;
  if (!hasFlag(args, 'wait')) throw new UsageError('--timeout is how long --wait waits; give --wait with it');
  if (!/^\d+$/.test(raw) || Number(raw) === 0) throw new UsageError(`--timeout must be a whole number of seconds, 1 or more (got "${raw}")`);
  return Number(raw) * 1000;
}

export default async function txCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  if (args.subcommand !== 'status') throw new UsageError(`Unknown tx subcommand: ${args.subcommand ?? '(none)'}. Use status.`);
  const given = args.positionals[0];
  if (given === undefined) throw new UsageError('tx status needs a transaction hash or identifier: midnight tx status <hash or identifier>');
  const ref = parseTxReference(given);
  const timeoutMs = timeoutMsOf(args);
  const jsonMode = hasFlag(args, 'json');
  const { name: network, config } = resolveNetwork({ args, configDir: ctx.config.paths.stateRoot }, ctx.config.settings);

  const progress = spinnerReporter(ctx.progress, jsonMode);
  const wait = hasFlag(args, 'wait');
  const status = await transactionStatus({ indexer: config.indexer, ref, wait, timeoutMs, signal: ctx.signal, onProgress: progress.report });
  // A wait that ended without the transaction gave up: SYNC_TIMEOUT (exit 4), never notFound with exit 0, so a script tells it from one that landed.
  if (wait && status.state === 'notFound') {
    throw new SyncTimeoutError(
      `The indexer at ${config.indexer} has not listed transaction ${given} after waiting ${timeoutMs / 1000} s: it may still be on its way, or it was dropped or never sent.\n`
      + `Wait longer with --timeout <seconds>, or ask again: midnight tx status ${given}`,
    );
  }

  if (jsonMode) {
    ctx.output.result({ subcommand: 'status', network, transaction: given, ...transactionStatusJson(status) });
    return;
  }
  ctx.output.stdout((status.state === 'final' ? (status.result ?? 'final') : 'notFound') + '\n');
  ctx.output.stderr('\n' + header('Transaction') + '\n\n');
  ctx.output.stderr(keyValue('Network', network) + '\n');
  if (status.state === 'notFound') {
    ctx.output.stderr(keyValue('State', 'not found') + '\n\n');
    ctx.output.stderr(dim('  The indexer lists only finalized transactions: this one is not on chain yet, was dropped, or was never sent.') + '\n\n');
    return;
  }
  ctx.output.stderr(keyValue('State', 'final') + '\n');
  ctx.output.stderr(keyValue('Hash', status.hash) + '\n');
  if (status.result !== undefined) ctx.output.stderr(keyValue('Result', status.result) + '\n');
  if (status.segments !== undefined) {
    ctx.output.stderr(keyValue('Segments', status.segments.map((s) => `${s.id}: ${s.success ? 'success' : 'failure'}`).join(', ')) + '\n');
  }
  if (status.feeSpecks !== undefined) ctx.output.stderr(keyValue('Fee', formatDust(status.feeSpecks)) + '\n');
  ctx.output.stderr(keyValue('Block', `${status.block.height} (${status.block.hash})`) + '\n');
  ctx.output.stderr(keyValue('Time', status.block.time.toISOString()) + '\n\n');
}
