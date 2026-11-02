// inspect-cost command — display the chain's current block limits, from the
// ledger parameters of its latest block, as the engine for the chain's SDK
// set reads them.

import { type ParsedArgs, hasFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { header, keyValue, divider } from '@kuiralabs/midnight-cli-core/ui/format';
import { bold, dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { resolveNetwork } from '@kuiralabs/midnight-cli-core/lib/resolve-network';
import { fetchLedgerParameters } from '../lib/chain-params.ts';
import { engineFor } from '@kuiralabs/midnight-cli-core/lib/engine';
import { assertLedgerSupported, fetchProtocolVersion } from '@kuiralabs/midnight-chain/lib/ledger-guard';

const UNITS: Record<string, string> = {
  readTime: 'picoseconds',
  computeTime: 'picoseconds',
  blockUsage: 'bytes',
  bytesWritten: 'bytes',
  bytesChurned: 'bytes',
};

export default async function inspectCostCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const { name: networkName, config } = resolveNetwork({ args });
  // A ledger-8 chain's parameters aren't ledger-9 ones: refuse it like every other chain read.
  await assertLedgerSupported(networkName, config, fetchProtocolVersion, ctx.signal);
  const { height, parametersHex } = await fetchLedgerParameters(config.indexer, ctx.signal);
  const limits = (await engineFor(networkName)).ledger.blockLimits(parametersHex);

  // JSON mode
  if (hasFlag(args, 'json')) {
    ctx.output.result({ ...limits, network: networkName, height });
    return;
  }

  // Bare data to stdout (pipeable)
  for (const [dimension, value] of Object.entries(limits)) {
    ctx.output.stdout(`${dimension}=${value}\n`);
  }

  // Formatted details to stderr
  ctx.output.stderr('\n' + header('Block Limits') + '\n\n');
  ctx.output.stderr(dim(`  From the ledger parameters of block ${height} on ${networkName}`) + '\n\n');

  for (const [dimension, value] of Object.entries(limits)) {
    const unit = UNITS[dimension] ?? '';
    ctx.output.stderr(keyValue(dimension, `${bold(value.toLocaleString())} ${dim(unit)}`) + '\n');
  }

  ctx.output.stderr('\n' + divider() + '\n');
  ctx.output.stderr(dim('  bytesWritten is typically the tightest constraint') + '\n');
  ctx.output.stderr(dim('  for large contract deployments.') + '\n\n');
}
