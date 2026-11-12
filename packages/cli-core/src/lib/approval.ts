// Terminal approval prompts for DApp Connector write operations
// Asks through the prompter its caller gives (the CLI's uses readline, per project constraints — no inquirer)

import type { NoticeSink } from './notices.ts';
import { PromptBusyError, type Prompter } from './prompter.ts';
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
  /**
   * A read whose answer hands the dApp a secret of the user's (getConfiguration
   * when the endpoints carry a Blockfrost project id): asked like a write, never
   * approved as a read.
   */
  revealsSecret?: boolean;
}

/** Approved; rejected by whoever answered; or nobody could be asked (no terminal, no prompter), which is no one's rejection. */
export type ApprovalResult = 'approve' | 'reject' | 'unavailable';

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
  /** Who is asked to approve (the host's prompter); null when nobody can, and every request that needs asking is rejected. */
  prompter: Prompter | null;
  /** Where what was approved without asking, and why a request was rejected, is said (the host's notices). */
  notice: NoticeSink;
}

/** What a server approves without asking, as `mn serve` reports it. */
export interface ApprovalPolicy {
  /** Read-only methods never prompt; getConfiguration does when its endpoints carry a Blockfrost project id, unless everything is approved. */
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

export function describeApprovalPolicy(options: Omit<ApprovalOptions, 'prompter' | 'notice'>, feeLimits: FeeLimits): ApprovalPolicy {
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

const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
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
const PREP_METHODS: ReadonlySet<string> = new Set([
  'balanceUnsealedTransaction',
  'balanceSealedTransaction',
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

export function isPrepMethod(method: string): boolean {
  return PREP_METHODS.has(method);
}

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
function nonInteractiveHint(request: ApprovalRequest, options: Pick<ApprovalOptions, 'approveFees'>): string {
  if (request.revealsSecret) {
    return `${request.method}'s endpoints carry your Blockfrost project id: approve it at a terminal, or use --approve-all to give it to every dApp`;
  }
  if (options.approveFees) {
    return `--approve-fees approves only paying the Dust fee for an agent's own balanced transaction (and its submit); ${request.method} needs a terminal to approve`;
  }
  const what = isPrepMethod(request.method) ? 'Balancing prompts like any other write' : `${request.method} needs a terminal to approve`;
  return `${what}: use --approve-all for non-interactive environments, or --approve-fees for a fee wallet that only pays an agent's Dust fee`;
}

/**
 * Prompt the user to approve or reject a DApp Connector operation.
 * Returns 'approve', 'reject', or 'unavailable' when nobody can be asked.
 *
 * If options.approveAll is true, auto-approves without prompting.
 * If options.approveFees is true, auto-approves a fee-only request.
 * If options.autoApproveReads is true and the method is read-only (and reveals no secret), auto-approves.
 *
 * Unavailable if stdin is not a TTY (non-interactive environment) or the host gave no prompter.
 * Only one prompt can be active at a time: the prompter refuses a second
 * question while one is open, and the request is rejected.
 */
export async function promptApproval(
  request: ApprovalRequest,
  options: ApprovalOptions,
): Promise<ApprovalResult> {
  const { notice } = options;
  // Auto-approve checks
  if (options.approveAll) {
    notice(dim(`  Auto-approved: ${request.method}`));
    return 'approve';
  }

  if (options.approveFees && request.feeOnly) {
    notice(dim(`  Auto-approved (fee-only): ${request.method}`));
    return 'approve';
  }

  if (options.autoApproveReads && isReadOnlyMethod(request.method) && request.revealsSecret !== true) {
    notice(dim(`  Auto-approved (read-only): ${request.method}`));
    return 'approve';
  }

  // Non-interactive environment: nobody to ask, so nothing is approved.
  const { prompter } = options;
  if (prompter === null || !prompter.isInteractive()) {
    notice(red(prompter === null
      ? '  Cannot prompt for approval: the host gave no prompter (createHost prompter)'
      : '  Cannot prompt for approval: stdin is not a TTY'));
    notice(dim(`  ${nonInteractiveHint(request, options)}`));
    return 'unavailable';
  }

  // The request is part of the question, so whoever answers sees what they approve.
  try {
    const answer = await prompter.ask('\n' + renderApprovalBox(request) + '\n\n' + yellow('  Approve? [A/r] '));
    // Input ended before an answer (e.g. piped input ends): reject.
    if (answer === null) return 'reject';
    const normalized = answer.trim().toLowerCase();
    // Default to approve (empty input, 'a', 'approve', 'y', 'yes')
    return normalized === 'r' || normalized === 'reject' ? 'reject' : 'approve';
  } catch (err) {
    // The terminal is answering another question: prompts never overlap on stdin.
    notice(red(err instanceof PromptBusyError ? '  Rejected: another approval prompt is active' : '  Cannot create readline interface'));
    return 'reject';
  }
}
