// `mn tx status`, as the shell runs it, answered by a stand-in indexer with
// test-support/fixtures/tx-status.ts. The chain's lookup, wait and receipt
// are the chain's tests (packages/chain/src/__tests__/tx-status.test.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, parseArgs } from '@kuiralabs/midnight-cli-core';
import { installedCommands } from '../lib/installed-commands.ts';
import { txDefinition } from '@kuiralabs/midnight-chain/commands';
import { startLocalIndexer, type LocalIndexer } from '../../test-support/local-indexer.ts';
import { BLOCK, HASH, IDENTIFIER, answer, regular } from '../../test-support/fixtures/tx-status.ts';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { cliCall } from './helpers/cli-call.ts';

// The tx handler, as the shell loads it.
const { default: txCommand } = await txDefinition.load();

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('mn tx status', () => {
  let io: CapturedOutput;
  let home: string;
  let savedHome: string | undefined;
  beforeEach(() => {
    savedHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'mn-tx-status-'));
    process.env.HOME = home;
    io = captureOutput();
  });
  afterEach(() => {
    io.restore();
    process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });
  const wsOf = (url: string) => url.replace('http://', 'ws://') + '/ws';
  const run = (...argv: string[]) => cliCall(txCommand, parseArgs(['tx', ...argv, '--network', 'preview', '--indexer-ws', wsOf(indexer!.url)]));

  it('prints the transaction as one JSON result', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    await run('status', IDENTIFIER, '--json');
    expect(JSON.parse(io.stdout())).toEqual({
      subcommand: 'status', network: 'preview', transaction: IDENTIFIER, state: 'final',
      kind: 'regular', hash: HASH, identifiers: [IDENTIFIER], result: 'SUCCESS', fee: '0.845170285714286', feeSpecks: '845170285714286',
      blockHeight: BLOCK.height, blockHash: BLOCK.hash, blockTime: '2026-11-03T08:55:18.000Z',
    });
  });

  it('prints the result on stdout and the details on stderr', async () => {
    indexer = await startLocalIndexer(() => answer([regular('SUCCESS')]));
    await run('status', IDENTIFIER);
    expect(io.stdout()).toBe('SUCCESS\n');
    expect(io.stderr()).toContain('0.845170285714286 DUST');
    expect(io.stderr()).toContain(String(BLOCK.height));
  });

  it('reports not found as a result, saying what it can mean', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    await run('status', IDENTIFIER);
    expect(io.stdout()).toBe('notFound\n');
    expect(io.stderr()).toContain('not on chain yet, was dropped, or was never sent');
  });

  it('with --wait, asks until it is listed', async () => {
    let asked = 0;
    indexer = await startLocalIndexer(() => (++asked < 2 ? answer([]) : answer([regular('SUCCESS')])));
    await run('status', IDENTIFIER, '--wait', '--timeout', '30', '--json');
    expect(JSON.parse(io.stdout()).state).toBe('final');
    expect(asked).toBe(2);
  });

  it('with --wait, a transaction still not listed when the wait ends is SYNC_TIMEOUT (exit 4), not notFound with exit 0', async () => {
    indexer = await startLocalIndexer(() => answer([]));
    const failure = run('status', IDENTIFIER, '--wait', '--timeout', '1', '--json');
    await expect(failure).rejects.toMatchObject({ code: 'SYNC_TIMEOUT', message: expect.stringContaining(`has not listed transaction ${IDENTIFIER} after waiting 1 s`) });
    expect(classifyError(await failure.catch((e: unknown) => e as Error) as Error, installedCommands)).toEqual({ exitCode: 4, errorCode: 'SYNC_TIMEOUT' });
    expect(io.stdout()).toBe('');
  });

  it.each([
    [['status'], 'needs a transaction hash or identifier'],
    [['status', 'xyz'], 'is not a transaction hash'],
    [['status', IDENTIFIER, '--timeout', '5'], 'give --wait with it'],
    [['status', IDENTIFIER, '--wait', '--timeout', '0'], 'whole number of seconds'],
    [['list'], 'Unknown tx subcommand'],
  ])('refuses %j as a usage error', async (argv, message) => {
    indexer = await startLocalIndexer(() => answer([]));
    await expect(run(...argv)).rejects.toThrow(message);
    expect(indexer.requests).toHaveLength(0);
  });
});
