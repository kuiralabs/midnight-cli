import { type Prompter } from '../lib/prompter.ts';
import { describeApprovalPolicy, renderApprovalBox, isReadOnlyMethod, isPrepMethod, type ApprovalRequest } from '../lib/approval.ts';
import { createTerminalPrompter } from '../ui/terminal-prompter.ts';
import { promptApproval, type ApprovalOptions } from '../lib/approval.ts';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Strip ANSI codes for content assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('approval', () => {
  describe('isReadOnlyMethod', () => {
    it('returns true for read-only methods', () => {
      expect(isReadOnlyMethod('getUnshieldedBalances')).toBe(true);
      expect(isReadOnlyMethod('getShieldedBalances')).toBe(true);
      expect(isReadOnlyMethod('getDustBalance')).toBe(true);
      expect(isReadOnlyMethod('getShieldedAddresses')).toBe(true);
      expect(isReadOnlyMethod('getUnshieldedAddress')).toBe(true);
      expect(isReadOnlyMethod('getDustAddress')).toBe(true);
      expect(isReadOnlyMethod('getTxHistory')).toBe(true);
      expect(isReadOnlyMethod('getConfiguration')).toBe(true);
      expect(isReadOnlyMethod('getConnectionStatus')).toBe(true);
    });

    it('returns false for write and prep methods', () => {
      expect(isReadOnlyMethod('makeTransfer')).toBe(false);
      expect(isReadOnlyMethod('submitTransaction')).toBe(false);
      expect(isReadOnlyMethod('balanceUnsealedTransaction')).toBe(false);
      expect(isReadOnlyMethod('balanceSealedTransaction')).toBe(false);
      expect(isReadOnlyMethod('signData')).toBe(false);
      expect(isReadOnlyMethod('makeIntent')).toBe(false);
    });

    it('returns false for unknown methods', () => {
      expect(isReadOnlyMethod('unknownMethod')).toBe(false);
    });
  });

  describe('isPrepMethod', () => {
    it('returns true for balance transaction methods', () => {
      expect(isPrepMethod('balanceUnsealedTransaction')).toBe(true);
      expect(isPrepMethod('balanceSealedTransaction')).toBe(true);
    });

    it('returns false for write methods', () => {
      expect(isPrepMethod('submitTransaction')).toBe(false);
      expect(isPrepMethod('makeTransfer')).toBe(false);
      expect(isPrepMethod('signData')).toBe(false);
      expect(isPrepMethod('makeIntent')).toBe(false);
    });

    it('returns false for read-only methods', () => {
      expect(isPrepMethod('getUnshieldedBalances')).toBe(false);
      expect(isPrepMethod('getConfiguration')).toBe(false);
    });

    it('returns false for unknown methods', () => {
      expect(isPrepMethod('unknownMethod')).toBe(false);
    });
  });

  describe('renderApprovalBox', () => {
    it('renders a box with method and network', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('DApp Request');
      expect(output).toContain('makeTransfer');
      expect(output).toContain('undeployed');
      expect(output).toContain('[A]pprove');
      expect(output).toContain('[R]eject');
    });

    it('includes dapp name when provided', () => {
      const request: ApprovalRequest = {
        method: 'submitTransaction',
        dappName: 'MyDEX',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('Request from "MyDEX"');
      // Should NOT have generic title
      expect(output).not.toContain('DApp Request');
    });

    it('renders details with labels and values', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [
          { label: 'Amount', value: '10.000000 NIGHT' },
          { label: 'To', value: 'mn_addr_undeployed1abc...' },
        ],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('Amount:');
      expect(output).toContain('10.000000 NIGHT');
      expect(output).toContain('To:');
      expect(output).toContain('mn_addr_undeployed1abc...');
    });

    it('uses heavy box drawing characters', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('╔');
      expect(output).toContain('╗');
      expect(output).toContain('╚');
      expect(output).toContain('╝');
    });

    it('renders Action and Network on separate lines', () => {
      const request: ApprovalRequest = {
        method: 'signData',
        network: 'preprod',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      const lines = output.split('\n');
      const actionLine = lines.find(l => l.includes('Action:'));
      const networkLine = lines.find(l => l.includes('Network:'));
      expect(actionLine).toBeDefined();
      expect(networkLine).toBeDefined();
      expect(actionLine).toContain('signData');
      expect(networkLine).toContain('preprod');
    });
  });

  describe('promptApproval', () => {
    const baseRequest: ApprovalRequest = {
      method: 'makeTransfer',
      network: 'undeployed',
      details: [],
    };

    // What approval says goes out as the notices it is given; with no prompter, there is no terminal to ask at.
    let stderrOutput: string[];
    let asker: { prompter: Prompter | null; notice: (line: string) => void };

    beforeEach(() => {
      stderrOutput = [];
      asker = { prompter: null, notice: (line) => stderrOutput.push(line + '\n') };
    });

    /** A terminal that answers through a stream, and the stream to type into. */
    let shown = '';
    const terminal = () => {
      const input = new PassThrough();
      const output = new PassThrough();
      shown = '';
      output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8'); });
      asker.prompter = createTerminalPrompter({ input, output, isTTY: true });
      return input;
    };

    it('auto-approves when approveAll is true', async () => {
      const result = await promptApproval(baseRequest, { ...asker, approveAll: true });
      expect(result).toBe('approve');
    });

    it('logs auto-approval for approveAll', async () => {
      await promptApproval(baseRequest, { ...asker, approveAll: true });
      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Auto-approved: makeTransfer');
    });

    it('auto-approves read-only methods when autoApproveReads is true', async () => {
      const readRequest: ApprovalRequest = {
        method: 'getUnshieldedBalances',
        network: 'undeployed',
        details: [],
      };
      const result = await promptApproval(readRequest, { ...asker, autoApproveReads: true });
      expect(result).toBe('approve');
    });

    it('logs auto-approval for read-only methods', async () => {
      const readRequest: ApprovalRequest = {
        method: 'getUnshieldedBalances',
        network: 'undeployed',
        details: [],
      };
      await promptApproval(readRequest, { ...asker, autoApproveReads: true });
      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Auto-approved (read-only)');
    });

    // Balancing signs and returns a finished transaction a dApp can submit
    // through any node, so it is a write: it prompts unless --approve-all, or
    // --approve-fees for a fee-only balance.
    it.each(['balanceUnsealedTransaction', 'balanceSealedTransaction'])(
      'prompts for %s even with autoApproveReads (no terminal: rejected), naming the flags that would approve it',
      async (method) => {
        try {
          const result = await promptApproval({ method, network: 'undeployed', details: [] }, { ...asker, autoApproveReads: true });
          expect(result).toBe('reject');
          const written = stripAnsi(stderrOutput.join(''));
          expect(written).not.toContain('Auto-approved');
          expect(written).toContain('Balancing prompts like any other write: use --approve-all for non-interactive environments, or --approve-fees');
        } finally {
        }
      },
    );

    it.each(['balanceUnsealedTransaction', 'balanceSealedTransaction'])('approves %s with --approve-all', async (method) => {
      expect(await promptApproval({ method, network: 'undeployed', details: [] }, { ...asker, approveAll: true, autoApproveReads: true })).toBe('approve');
    });

    it('does not auto-approve balancing when autoApproveReads is false', async () => {

      const prepRequest: ApprovalRequest = {
        method: 'balanceUnsealedTransaction',
        network: 'undeployed',
        details: [],
      };
      const result = await promptApproval(prepRequest, { ...asker, autoApproveReads: false });
      expect(result).toBe('reject'); // falls through to non-TTY rejection
    });

    it('does not auto-approve write methods when only autoApproveReads is set', async () => {
      // Non-TTY stdin will cause immediate rejection

      const result = await promptApproval(baseRequest, { ...asker, autoApproveReads: true });
      expect(result).toBe('reject');
    });

    describe('fee-only policy (--approve-fees)', () => {
      // Every case runs non-interactively: an agent can't answer a prompt,
      // so anything the policy doesn't approve must be rejected outright.

      it.each(['balanceUnsealedTransaction', 'balanceSealedTransaction', 'submitTransaction'])(
        'auto-approves a fee-only %s and says why',
        async (method) => {
          const result = await promptApproval({ ...baseRequest, method, feeOnly: true }, { ...asker, approveFees: true });
          expect(result).toBe('approve');
          expect(stripAnsi(stderrOutput.join(''))).toContain(`Auto-approved (fee-only): ${method}`);
        },
      );

      it.each(['makeTransfer', 'makeIntent', 'signData', 'submitTransaction', 'balanceUnsealedTransaction'])(
        'rejects %s when it is not fee-only',
        async (method) => {
          const result = await promptApproval({ ...baseRequest, method }, { ...asker, approveFees: true });
          expect(result).toBe('reject');
        },
      );

      it('grants nothing from a fee-only request when the server was not started with --approve-fees', async () => {
        const result = await promptApproval({ ...baseRequest, method: 'submitTransaction', feeOnly: true }, asker);
        expect(result).toBe('reject');
      });
    });

    it('rejects when stdin is not a TTY', async () => {
      asker.prompter = createTerminalPrompter({ input: new PassThrough(), output: new PassThrough(), isTTY: false });

      const result = await promptApproval(baseRequest, asker);
      expect(result).toBe('reject');

      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Cannot prompt for approval: stdin is not a TTY');
    });

    it('rejects when the host set no prompter, saying so', async () => {
      const result = await promptApproval(baseRequest, asker);
      expect(result).toBe('reject');

      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Cannot prompt for approval: the host gave no prompter (createHost prompter)');
    });

    describe('without a terminal, the hint names what the server could have been started with', () => {

      it('suggests --approve-all, or --approve-fees for a fee wallet, on a server with neither', async () => {
        expect(await promptApproval(baseRequest, asker)).toBe('reject');
        const written = stripAnsi(stderrOutput.join(''));
        expect(written).toContain('makeTransfer needs a terminal to approve: use --approve-all for non-interactive environments, or --approve-fees for a fee wallet');
      });

      it('on a fee wallet, says the request is outside --approve-fees and names the method', async () => {
        expect(await promptApproval(baseRequest, { ...asker, approveFees: true })).toBe('reject');
        const written = stripAnsi(stderrOutput.join(''));
        expect(written).toContain("--approve-fees approves only paying the Dust fee for an agent's own balanced transaction");
        expect(written).toContain('makeTransfer needs a terminal to approve');
        expect(written).not.toContain('Use --approve-all');
      });
    });

    it('rejects concurrent prompts when one is already active', async () => {
      const input = terminal();
      const first = promptApproval(baseRequest, asker);

      // The second call rejects at once while the first is waiting for its answer.
      expect(await promptApproval(baseRequest, asker)).toBe('reject');
      expect(stripAnsi(stderrOutput.join(''))).toContain('another approval prompt is active');

      input.write('a\n');
      expect(await first).toBe('approve');
    });

    it('asks at the terminal, showing the request: Enter approves, r rejects, and an ended input rejects', async () => {
      let input = terminal();
      const approving = promptApproval(baseRequest, asker);
      input.write('\n');
      expect(await approving).toBe('approve');
      // The request is shown as part of the question, whatever the host does with notices.
      expect(stripAnsi(shown)).toContain('makeTransfer');
      expect(stripAnsi(shown)).toContain('Approve? [A/r]');
      expect(stderrOutput.join('')).not.toContain('makeTransfer');

      input = terminal();
      const rejecting = promptApproval(baseRequest, asker);
      input.write('r\n');
      expect(await rejecting).toBe('reject');

      input = terminal();
      const ended = promptApproval(baseRequest, asker);
      input.end();
      expect(await ended).toBe('reject');
    });
  });
});

/** What a server is started with: the approval options but who asks and where it is said. */
type ApprovalFlags = Omit<ApprovalOptions, 'prompter' | 'notice'>;

describe('describeApprovalPolicy (what mn serve reports, in its header and --json)', () => {
  const limits = { maxFeeSpecks: 10n ** 15n / 2n, maxPending: 3 };

  it.each([
    ['--approve-all', { approveAll: true, autoApproveReads: true }, { reads: 'auto', balancing: 'auto', writes: 'auto' }],
    ['--approve-fees', { approveFees: true, autoApproveReads: true }, {
      reads: 'auto', balancing: 'fee-only', writes: 'fee-only', feeLimits: { maxFeeSpecks: '500000000000000', maxPending: 3 },
    }],
    ['the default', { autoApproveReads: true }, { reads: 'auto', balancing: 'prompt', writes: 'prompt' }],
    ['--no-auto-approve-reads', {}, { reads: 'auto', balancing: 'prompt', writes: 'prompt' }],
  ] as const)('%s', (_flags, options, expected) => {
    expect(describeApprovalPolicy(options, limits)).toEqual(expected);
  });

  it('is plain JSON (no bigint), so --json can print it', () => {
    expect(() => JSON.stringify(describeApprovalPolicy({ approveFees: true }, limits))).not.toThrow();
  });

  describe('matches what promptApproval decides without a terminal', () => {
    // No prompter: no terminal to ask at. What approval says is dropped.
    const decide = (method: string, flags: ApprovalFlags, feeOnly = false) =>
      promptApproval({ method, network: 'undeployed', details: [], feeOnly }, { ...flags, prompter: null, notice: () => {} });
    // What each claim means for a request of that kind: 'auto' approves anything,
    // 'fee-only' approves only a fee-only request, 'prompt' approves nothing.
    const expectedFor = (claim: string, feeOnly: boolean) =>
      claim === 'auto' || (claim === 'fee-only' && feeOnly) ? 'approve' : 'reject';

    it.each([
      [{ approveAll: true, autoApproveReads: true }],
      [{ approveFees: true, autoApproveReads: true }],
      [{ autoApproveReads: true }],
      [{}],
    ] as Array<[ApprovalFlags]>)('%j', async (options) => {
      const policy = describeApprovalPolicy(options, limits);
      for (const feeOnly of [false, true]) {
        for (const method of ['balanceUnsealedTransaction', 'balanceSealedTransaction']) {
          expect(await decide(method, options, feeOnly), `${method} feeOnly=${feeOnly}`).toBe(expectedFor(policy.balancing, feeOnly));
        }
        for (const method of ['submitTransaction', 'makeTransfer', 'makeIntent', 'signData']) {
          const claimed = method === 'submitTransaction' ? expectedFor(policy.writes, feeOnly) : expectedFor(policy.writes, false);
          expect(await decide(method, options, feeOnly && method === 'submitTransaction'), `${method} feeOnly=${feeOnly}`).toBe(claimed);
        }
      }
    });
  });
});
