// inspect-cost command — display the chain's current block limits, from the
// ledger parameters of its latest block. Uses the probeDimension technique
// from the reference implementation.

import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { header, keyValue, divider } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import type { CallContext } from '../lib/call-context.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { fetchLedgerParameters } from '../lib/chain-params.ts';
import { assertLedgerSupported, fetchProtocolVersion } from '../lib/ledger-guard.ts';

interface SyntheticCost {
  readTime: bigint;
  computeTime: bigint;
  blockUsage: bigint;
  bytesWritten: bigint;
  bytesChurned: bigint;
}

/**
 * Probe a single block limit dimension by reverse-engineering normalizeFullness.
 * normalized = value / limit → limit = value / normalized
 */
function probeDimension(
  params: ledger.LedgerParameters,
  dimension: keyof SyntheticCost,
  probeValue: bigint,
): number {
  const cost: SyntheticCost = {
    readTime: 0n,
    computeTime: 0n,
    blockUsage: 0n,
    bytesWritten: 0n,
    bytesChurned: 0n,
  };
  cost[dimension] = probeValue;

  // Cast required: our SyntheticCost shape matches the ledger type but TS can't verify the opaque SDK type
  const normalized = params.normalizeFullness(cost as unknown as ledger.SyntheticCost);
  const normalizedValue = (normalized as Record<string, number>)[dimension]!;
  return Math.round(Number(probeValue) / normalizedValue);
}

function deriveBlockLimits(params: ledger.LedgerParameters) {
  return {
    readTime: probeDimension(params, 'readTime', 1_000_000_000n),
    computeTime: probeDimension(params, 'computeTime', 1_000_000_000n),
    blockUsage: probeDimension(params, 'blockUsage', 10_000n),
    bytesWritten: probeDimension(params, 'bytesWritten', 10_000n),
    bytesChurned: probeDimension(params, 'bytesChurned', 1_000_000n),
  };
}

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
  const { height, params } = await fetchLedgerParameters(config.indexer, ctx.signal);
  const limits = deriveBlockLimits(params);

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
