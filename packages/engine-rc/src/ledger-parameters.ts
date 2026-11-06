// A chain's block limits, from its ledger parameters' bytes. The ledger
// doesn't expose the limits themselves, so each is probed through
// normalizeFullness: normalized = value / limit, so limit = value / normalized.

import * as ledger from '@midnightntwrk/ledger-v9';
import type { BlockLimits } from '@kuiralabs/midnight-cli-core/engine';

type Dimension = keyof BlockLimits;

function probeDimension(params: ledger.LedgerParameters, dimension: Dimension, probeValue: bigint): number {
  const cost: Record<Dimension, bigint> = { readTime: 0n, computeTime: 0n, blockUsage: 0n, bytesWritten: 0n, bytesChurned: 0n };
  cost[dimension] = probeValue;
  // Cast required: the shape matches the ledger's SyntheticCost, which TS can't verify for the opaque SDK type.
  const normalized = params.normalizeFullness(cost as unknown as ledger.SyntheticCost);
  const normalizedValue = (normalized as Record<string, number>)[dimension]!;
  return Math.round(Number(probeValue) / normalizedValue);
}

/** The block limits in serialized ledger parameters (hex). Throws when the bytes aren't this ledger's parameters. */
export function blockLimitsOf(parametersHex: string): BlockLimits {
  const params = ledger.LedgerParameters.deserialize(Buffer.from(parametersHex, 'hex'));
  return {
    readTime: probeDimension(params, 'readTime', 1_000_000_000n),
    computeTime: probeDimension(params, 'computeTime', 1_000_000_000n),
    blockUsage: probeDimension(params, 'blockUsage', 10_000n),
    bytesWritten: probeDimension(params, 'bytesWritten', 10_000n),
    bytesChurned: probeDimension(params, 'bytesChurned', 1_000_000n),
  };
}
