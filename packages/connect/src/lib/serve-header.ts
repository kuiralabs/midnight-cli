// The lines mn serve's header starts with: what it serves, and what it
// approves without asking. Every key is padded to the longest one's width, so
// each value stands apart from its key and all values line up.

import type { ApprovalPolicy, FeeLimits } from '@kuiralabs/midnight-cli-core';
import { keyValue, toDust } from '@kuiralabs/midnight-cli-core/ui';

/** The header's key-value lines, before any note, for a serve with this policy. */
export function serveHeaderLines(served: { network: string; address: string; port: number; allowedOrigins?: readonly string[] }, policy: ApprovalPolicy, feeLimits: FeeLimits): string[] {
  const origins = served.allowedOrigins ?? [];
  const rows: Array<[string, string]> = [
    ['Network', served.network],
    ['Address', served.address],
    ['Port', String(served.port)],
    ['Browser pages', origins.length === 0 ? 'refused (none allowed; see --allow-origin)' : `only ${origins.join(', ')}`],
    ['Auto-approve balancing', { auto: 'yes', 'fee-only': 'fee-only (Dust fee only)', prompt: 'no' }[policy.balancing]],
    ['Auto-approve writes', { auto: 'yes', 'fee-only': 'fee-only (submit of a fee-only balance)', prompt: 'no' }[policy.writes]],
  ];
  if (policy.feeLimits) rows.push(['Fee limits', `max ${toDust(feeLimits.maxFeeSpecks)} DUST per tx, ${feeLimits.maxPending} unsubmitted at once`]);
  // keyValue adds the colon; one space at least after it.
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  return rows.map(([key, value]) => keyValue(key, value, width));
}

/**
 * The warning for a serve that approves every request and lets browser pages
 * connect: any script those pages run can spend from the wallet and have it
 * sign, with nobody asked. Undefined when either isn't so.
 */
export function approveAllBrowserWarning(policy: ApprovalPolicy, allowedOrigins: readonly string[]): string | undefined {
  if (policy.writes !== 'auto' || allowedOrigins.length === 0) return undefined;
  return `Warning: --approve-all with --allow-origin: any script on ${allowedOrigins.join(', ')} can spend from this wallet and have it sign, without being asked. Allow only pages you control, and use a wallet holding only what you can lose.`;
}
