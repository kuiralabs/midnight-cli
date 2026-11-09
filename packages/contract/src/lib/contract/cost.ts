// What a contract deploy or call costs, said before it is proven: mn serve's
// price of the transaction midnight-js is about to prove (TransactionPrice:
// what the wallet commits to its fee, with its own Dust spend and margin),
// and the fee at the chain's prices now, which is what it commits over the
// margin. The wallet burns all it commits; the chain's fee is the price at the
// block the transaction lands in, which moves with how full blocks are.

import { formatWait, type Host, type NetworkName, OWN_COMMAND_DUST_WAIT_MS, sdkSetOf, type TransactionPrice } from '@kuiralabs/midnight-cli-core';
import { toDust } from '@kuiralabs/midnight-cli-core/ui';
import { fetchLedgerParameters } from '../chain-params.ts';

/** A deploy's or call's cost before it is proven, in Specks. */
export interface ContractCost {
  /** The fee at the chain's fee prices now. */
  fee: bigint;
  /** The Dust the wallet commits to the fee: `fee` with the wallet's margin of rising prices, all of it burned. */
  committed: bigint;
  /** The Dust the wallet has. */
  have: bigint;
  /** Whether `have` covers `committed`. */
  covers: boolean;
  /** Seconds the wallet's registered NIGHT takes to generate the rest: 0 when it covers already, null when not within a day. */
  waitSeconds: number | null;
  /** The blocks of margin `committed` is priced with. */
  marginBlocks: number;
}

// The margin's factor in parts of 10^12, so the fee (beyond 2^53 Specks) is divided in bigints.
const PARTS = 1_000_000_000_000n;

/**
 * The cost in `price`, with the fee at the chain's prices now: what the wallet
 * commits, over `maxPriceAdjustment` (the most prices rise in a block) to the
 * power of the margin's blocks, as the ledger's fees_with_margin multiplies it.
 */
export function contractCostOf(price: TransactionPrice, maxPriceAdjustment: number): ContractCost {
  const { committed, have, covers, waitMs, marginBlocks } = price;
  const factor = BigInt(Math.round(maxPriceAdjustment ** marginBlocks * Number(PARTS)));
  return {
    fee: committed * PARTS / factor,
    committed,
    have,
    covers,
    waitSeconds: waitMs === null ? null : Math.ceil(waitMs / 1000),
    marginBlocks,
  };
}

/** A cost as the `cost` field of `--json` output: the amounts in DUST, as decimal strings. */
export interface ContractCostJson {
  fee: string;
  committed: string;
  have: string;
  covers: boolean;
  waitSeconds: number | null;
  marginBlocks: number;
}

export function contractCostJson(cost: ContractCost): ContractCostJson {
  return {
    fee: toDust(cost.fee),
    committed: toDust(cost.committed),
    have: toDust(cost.have),
    covers: cost.covers,
    waitSeconds: cost.waitSeconds,
    marginBlocks: cost.marginBlocks,
  };
}

/** How long a wallet short of Dust waits for the rest (`waitSeconds` of a cost), and whether mn waits that long. */
export function dustWaitPhrase(waitSeconds: number | null): string {
  if (waitSeconds === null) return 'its registered NIGHT won\'t generate the rest within a day (register more: midnight dust register)';
  const waitMs = waitSeconds * 1000;
  return `its registered NIGHT generates the rest in ${formatWait(waitMs)}`
    + (waitMs <= OWN_COMMAND_DUST_WAIT_MS ? ', which mn waits for' : `, longer than the ${formatWait(OWN_COMMAND_DUST_WAIT_MS)} mn waits`);
}

/** A cost (as `--json` gives it) in a sentence, for the text a person confirms a deploy or call with: no full stop, as a confirmation's text has none for what follows it. */
export function costSentence(cost: ContractCostJson): string {
  const held = cost.covers ? 'which covers it' : `short of it: ${dustWaitPhrase(cost.waitSeconds)}`;
  return `Expected fee ${cost.fee} DUST at the chain's prices now; the wallet commits ${cost.committed} DUST to it (${cost.marginBlocks} blocks of margin, all of it burned) and holds ${cost.have} DUST, ${held}`;
}

/** What a confirmation says in a cost's place when pricing failed with `err`: the failure's first line. */
export function unpricedSentence(err: unknown): string {
  const said = (err instanceof Error ? err.message : String(err)).split('\n')[0]!.trim().replace(/\.$/, '');
  return `Its cost could not be worked out first (${said})`;
}

/** The most the fee prices of `network` can rise in a block, from its latest block's ledger parameters, as the engine for the network reads them. */
export async function maxPriceAdjustmentOn(host: Host, target: { network: NetworkName; root: string; networkConfig: { indexer: string } }, signal?: AbortSignal): Promise<number> {
  const { parametersHex } = await fetchLedgerParameters(target.networkConfig.indexer, signal);
  const engine = await host.engines.load(sdkSetOf(target.network, target.root));
  return engine.ledger.maxPriceAdjustment(parametersHex);
}

/** A deploy's or call's transaction was priced, before it is proven. */
export interface ContractPriced {
  readonly kind: 'contract-priced';
  readonly cost: ContractCost;
}

/** A deploy or call priced and stopped there (`--dry-run`): nothing was proven or sent. */
export interface PricedContract {
  readonly network: NetworkName;
  readonly contractName: string;
  readonly cost: ContractCost;
}

/**
 * Turns each price a script reports into a cost (with `maxPriceAdjustment`),
 * says it through `onPriced`, and keeps the last for `cost()`.
 */
export function costRecorder(maxPriceAdjustment: number, onPriced: ((event: ContractPriced) => void) | undefined): { onPrice: (price: TransactionPrice) => void; cost: () => ContractCost | undefined } {
  let last: ContractCost | undefined;
  return {
    onPrice: (price) => {
      last = contractCostOf(price, maxPriceAdjustment);
      onPriced?.({ kind: 'contract-priced', cost: last });
    },
    cost: () => last,
  };
}
