// Terminal approval prompts for DApp Connector write operations
// Asks through the prompter the host sets (the CLI's uses readline, per project constraints — no inquirer)

import { notice } from './notices.ts';
import { currentPrompter } from './prompter.ts';
import { box } from '../ui/format.ts';
import { bold, teal, dim, yellow, green, red } from '../ui/colors.ts';
import type { FeeLimits } from './fee-limits.ts';

// ── Types ──

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface ApprovalRequest {
  /** DApp Connector method name (e.g. 'makeTransfer', 'submitTransaction') */
  method: string;
  /** Optional DApp identifier */
  dappName?: string;
  /** Network ID */
  network: string;
  /** Key-value details to display */
  details: ApprovalDetail[];
  /**
   * The wallet's whole contribution is the fee: a balance run Dust-only, or the
   * submit of a transaction this server balanced that way. Only counts under
   * `approveFees`.
   */
  feeOnly?: boolean;
}

export type ApprovalResult = 'approve' | 'reject';

export interface ApprovalOptions {
  /** Auto-approve read-only methods without prompting */
  autoApproveReads?: boolean;
  /** Auto-approve all operations (for agent/automated use) */
  approveAll?: boolean;
  /**
   * Fee-wallet mode: auto-approve requests where the wallet only pays the fee
   * (`feeOnly`). Everything else still needs a prompt, so an agent without a
   * terminal gets it rejected.
   */
  approveFees?: boolean;
}

/** What a server approves without asking, as `mn serve` reports it. */
export interface ApprovalPolicy {
  /** Read-only methods never prompt. */
  reads: 'auto';
  /**
   * balanceUnsealedTransaction / balanceSealedTransaction, which reserve the
   * wallet's coins and sign: approved without a prompt, only fee-only ones, or
   * each prompted.
   */
  balancing: 'auto' | 'fee-only' | 'prompt';
  /** submitTransaction, makeTransfer, makeIntent and signData: approved, only the submit of a fee-only balance, or each prompted. */
  writes: 'auto' | 'fee-only' | 'prompt';
  /** Under fee-only: the most Dust one transaction may cost (specks, as a string) and how many may wait unsubmitted. */
  feeLimits?: { maxFeeSpecks: string; maxPending: number };
}

export function describeApprovalPolicy(options: ApprovalOptions, feeLimits: FeeLimits): ApprovalPolicy {
  if (options.approveAll) return { reads: 'auto', balancing: 'auto', writes: 'auto' };
  if (options.approveFees) {
    return {
      reads: 'auto',
      balancing: 'fee-only',
      writes: 'fee-only',
      feeLimits: { maxFeeSpecks: feeLimits.maxFeeSpecks.toString(), maxPending: feeLimits.maxPending },
    };
  }
  return { reads: 'auto', balancing: 'prompt', writes: 'prompt' };
}

// ── Read-only method set ──

const READ_ONLY_METHODS = new Set([
  'getShieldedBalances',
  'getUnshieldedBalances',
  'getDustBalance',
  'getShieldedAddresses',
  'getUnshieldedAddress',
  'getDustAddress',
  'getTxHistory',
  'getConfiguration',
  'getConnectionStatus',
]);

/**
 * Balancing methods. Not reads: they reserve the wallet's coins and sign, and
 * the result is a finished transaction the dApp can submit through any node.
 * So they prompt like any other write, unless the server runs with
 * --approve-all, or --approve-fees for a fee-only balance.
 */
const PREP_METHODS = new Set([
  'balanceUnsealedTransaction',
  'balanceSealedTransaction',
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

export function isPrepMethod(method: string): boolean {
  return PREP_METHODS.has(method);
}

// ── Concurrent prompt guard ──

let promptActive = false;

// ── Rendering ──

export function renderApprovalBox(request: ApprovalRequest): string {
  const lines: string[] = [];

  // Title
  const title = request.dappName
    ? `Request from "${request.dappName}"`
    : 'DApp Request';
  lines.push(bold(title));
  lines.push('');

  // Method and network
  lines.push(`  ${dim('Action:')}   ${teal(request.method)}`);
  lines.push(`  ${dim('Network:')}  ${request.network}`);

  // Details
  if (request.details.length > 0) {
    lines.push('');
    for (const detail of request.details) {
      lines.push(`  ${dim(detail.label + ':')}  ${detail.value}`);
    }
  }

  lines.push('');
  lines.push(`  ${green('[A]pprove')}  ${red('[R]eject')}`);

  return box(lines, 'heavy');
}

// ── Prompt ──

/** What a server without a terminal can do about a request it can't prompt for. */
function nonInteractiveHint(request: ApprovalRequest, options: ApprovalOptions): string {
  if (options.approveFees) {
    return `--approve-fees approves only paying the Dust fee for an agent's own balanced transaction (and its submit); ${request.method} needs a terminal to approve`;
  }
  const what = isPrepMethod(request.method) ? 'Balancing prompts like any other write' : `${request.method} needs a terminal to approve`;
  return `${what}: use --approve-all for non-interactive environments, or --approve-fees for a fee wallet that only pays an agent's Dust fee`;
}

/**
 * Prompt the user to approve or reject a DApp Connector operation.
 * Returns 'approve' or 'reject'.
 *
 * If options.approveAll is true, auto-approves without prompting.
 * If options.approveFees is true, auto-approves a fee-only request.
 * If options.autoApproveReads is true and the method is read-only, auto-approves.
 *
 * Rejects if stdin is not a TTY (non-interactive environment).
 * Only one prompt can be active at a time — concurrent calls are rejected.
 */
export async function promptApproval(
  request: ApprovalRequest,
  options: ApprovalOptions = {},
): Promise<ApprovalResult> {
  // Auto-approve checks
  if (options.approveAll) {
    notice(dim(`  Auto-approved: ${request.method}`));
    return 'approve';
  }

  if (options.approveFees && request.feeOnly) {
    notice(dim(`  Auto-approved (fee-only): ${request.method}`));
    return 'approve';
  }

  if (options.autoApproveReads && isReadOnlyMethod(request.method)) {
    notice(dim(`  Auto-approved (read-only): ${request.method}`));
    return 'approve';
  }

  // Non-interactive environment — reject by default
  const prompter = currentPrompter();
  if (prompter === null || !prompter.isInteractive()) {
    notice(red('  Cannot prompt for approval: stdin is not a TTY'));
    notice(dim(`  ${nonInteractiveHint(request, options)}`));
    return 'reject';
  }

  // Prevent concurrent prompts from overlapping on stdin
  if (promptActive) {
    notice(red('  Rejected: another approval prompt is active'));
    return 'reject';
  }

  // Show the approval box, then ask
  notice('\n' + renderApprovalBox(request) + '\n');
  promptActive = true;
  try {
    const answer = await prompter.ask(yellow('  Approve? [A/r] '));
    // Input ended before an answer (e.g. piped input ends): reject.
    if (answer === null) return 'reject';
    const normalized = answer.trim().toLowerCase();
    // Default to approve (empty input, 'a', 'approve', 'y', 'yes')
    return normalized === 'r' || normalized === 'reject' ? 'reject' : 'approve';
  } catch {
    notice(red('  Cannot create readline interface'));
    return 'reject';
  } finally {
    promptActive = false;
  }
}
