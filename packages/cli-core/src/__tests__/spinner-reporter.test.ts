// A library function's progress events, shown on a call's spinners: each step
// a spinner on the terminal, or, silent (--json), nothing there while what the
// steps say still reaches the call's report (the MCP server's progress).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgress, spinnerReporter } from '../ui/spinner.ts';
import { captureOutput, type CapturedOutput } from '../../../../test-support/capture-output.ts';

let io: CapturedOutput;
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  process.env.NO_COLOR = '1';
  io = captureOutput();
});

afterEach(() => {
  io.restore();
  if (originalNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = originalNoColor;
});

describe('spinnerReporter', () => {
  it('shows each step as a spinner that ends with the step\'s last words, and reports every message', () => {
    const reported: string[] = [];
    const progress = createProgress((message) => reported.push(message));
    const reporter = spinnerReporter(progress, false);

    reporter.report({ kind: 'start', message: 'Checking unshielded...' });
    expect(progress.active()).not.toBeNull();
    reporter.report({ kind: 'update', message: 'Checking unshielded... 50%' });
    reporter.report({ kind: 'done', message: 'Unshielded ready' });
    expect(progress.active()).toBeNull();

    expect(io.stderr()).toContain('⠋ Checking unshielded...');
    expect(io.stderr()).toContain('✓ Unshielded ready\x1b[K\n');
    expect(reported).toEqual(['Checking unshielded...', 'Checking unshielded... 50%', 'Unshielded ready']);
  });

  it('silent, writes nothing on the terminal and reports every message, the start included', () => {
    const reported: string[] = [];
    const reporter = spinnerReporter(createProgress((message) => reported.push(message)), true);

    reporter.report({ kind: 'start', message: 'Asking the indexer...' });
    reporter.report({ kind: 'done', message: 'Final' });

    expect(io.stderr()).toBe('');
    expect(reported).toEqual(['Asking the indexer...', 'Final']);
  });

  it('fails the running step with a red mark, once, and nothing when no step runs', () => {
    const reporter = spinnerReporter(createProgress(), false);
    reporter.fail('Failed');
    expect(io.stderr()).toBe('');

    reporter.report({ kind: 'start', message: 'Syncing shielded...' });
    reporter.fail('Failed');
    reporter.fail('Failed');
    expect(io.stderr().match(/✗ Failed/g)).toHaveLength(1);
  });

  it('ignores an update or an end with no step running', () => {
    const reported: string[] = [];
    const reporter = spinnerReporter(createProgress((message) => reported.push(message)), false);
    reporter.report({ kind: 'update', message: 'late' });
    reporter.report({ kind: 'done', message: 'late' });
    expect(io.stderr()).toBe('');
    expect(reported).toEqual([]);
  });
});
