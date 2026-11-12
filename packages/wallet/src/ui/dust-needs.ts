// What a wallet's Dust is ready for once it registers: what a transfer and a
// counter contract's deploy take, and when its NIGHT has generated it. Right
// after a registration a wallet holds a fraction of a transfer's fee.

import { type DustNeed, type DustReadiness, formatWait } from '@kuiralabs/midnight-cli-core';
import { roughDust, toDust } from '@kuiralabs/midnight-cli-core/ui';

/** What a wallet's Dust is ready for, as `--json` gives it: the amounts in DUST, the waits in whole seconds (0: it has it; null: not within a day). */
export function dustNeedsJson(readiness: DustReadiness): Record<string, unknown> {
  const need = ({ needs, waitMs }: DustNeed) => ({ dust: toDust(needs), waitSeconds: waitMs === null ? null : Math.ceil(waitMs / 1000) });
  return { generatedPerSecond: toDust(readiness.perSecond), transfer: need(readiness.transfer), counterDeploy: need(readiness.counterDeploy) };
}

/** What a wallet's Dust is ready for, in words: what a transfer and a counter's deploy take, and when the wallet has it. */
export function dustNeedsText(readiness: DustReadiness): string[] {
  const when = ({ waitMs }: DustNeed): string => waitMs === 0 ? 'this wallet has it now'
    : waitMs === null ? "its registered NIGHT won't generate it within a day (register more: midnight dust register)"
      : `this wallet has it in ${formatWait(waitMs)}`;
  return [
    `A transfer takes about ${roughDust(readiness.transfer.needs, true)} DUST: ${when(readiness.transfer)}.`,
    `A counter contract's deploy takes about ${roughDust(readiness.counterDeploy.needs, true)} DUST: ${when(readiness.counterDeploy)}. Price yours: midnight contract deploy --dry-run.`,
    `Its registered NIGHT generates ${toDust(readiness.perSecond)} DUST a second.`,
  ];
}
