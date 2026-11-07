// The lines mn serve's header starts with: what it serves, and what it
// approves without asking. Every key is padded to the longest one's width, so
// each value stands apart from its key and all values line up.

import type { ApprovalPolicy, FeeLimits } from '@kuiralabs/midnight-cli-core';
import { keyValue, toDust } from '@kuiralabs/midnight-cli-core/ui';

/** The header's key-value lines, before any note, for a serve with this policy. */
export function serveHeaderLines(served: { network: string; address: string; port: number }, policy: ApprovalPolicy, feeLimits: FeeLimits): string[] {
  const rows: Array<[string, string]> = [
    ['Network', served.network],
    ['Address', served.address],
    ['Port', String(served.port)],
    ['Auto-approve balancing', { auto: 'yes', 'fee-only': 'fee-only (Dust fee only)', prompt: 'no' }[policy.balancing]],
    ['Auto-approve writes', { auto: 'yes', 'fee-only': 'fee-only (submit of a fee-only balance)', prompt: 'no' }[policy.writes]],
  ];
  if (policy.feeLimits) rows.push(['Fee limits', `max ${toDust(feeLimits.maxFeeSpecks)} DUST per tx, ${feeLimits.maxPending} unsubmitted at once`]);
  // keyValue adds the colon; one space at least after it.
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  return rows.map(([key, value]) => keyValue(key, value, width));
}
