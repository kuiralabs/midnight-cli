// Verbose is a call's own. Regression: --verbose switched on one
// module global, which stayed on, so once one call in a server asked for
// verbose lines, every later call wrote them too, and so did every library
// that any call reached.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { captureCommand } from '../lib/run-command.ts';
import { callDiagnostics } from '@kuiralabs/midnight-cli-core/lib/call-context';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { setNoticeSink } from '@kuiralabs/midnight-cli-core/lib/notices';
import { deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { WalletDataRepository } from '@kuiralabs/midnight-engine-rc/wallet-data-repository';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import balanceCommand from '../commands/balance.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { ownCall } from './helpers/own-call.ts';
import { testHost } from './helpers/test-host.ts';

// One host for every call, as the MCP server has: its notices are where verbose lines go.
const host = testHost({ notice: (line) => notices.push(line) });

// Nothing listens here: each call fails at its first connection, after its first diagnostic.
const UNREACHABLE = ['--indexer-ws', 'ws://127.0.0.1:1/api/v4/graphql/ws', '--node', 'ws://127.0.0.1:1', '--proof-server', 'http://127.0.0.1:1'];
const VERBOSE_ADDRESS = deriveUnshieldedAddress(Buffer.from('aa'.repeat(32), 'hex'), 'undeployed');
const QUIET_ADDRESS = deriveUnshieldedAddress(Buffer.from('bb'.repeat(32), 'hex'), 'undeployed');

let notices: string[];
let io: CapturedOutput;
let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-verbose-per-call-'));
  process.env.HOME = home;
  process.env.MN_NO_LOCAL_DETECT = '1';
  notices = [];
  setNoticeSink((line) => notices.push(line));
  io = captureOutput();
});

afterEach(() => {
  io.restore();
  setNoticeSink(null);
  delete process.env.MN_NO_LOCAL_DETECT;
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe('verbose, per call', () => {
  it('two balance calls at once, one --verbose: only the verbose one writes diagnostic lines', async () => {
    const verboseCall = captureCommand(balanceCommand, parseArgs(['balance', VERBOSE_ADDRESS, '--verbose', ...UNREACHABLE]), ownCall({ host }));
    const quietCall = captureCommand(balanceCommand, parseArgs(['balance', QUIET_ADDRESS, ...UNREACHABLE]), ownCall({ host }));
    const outcomes = await Promise.allSettled([verboseCall, quietCall]);
    // Neither reaches an indexer; both fail, each with its own error.
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    expect(notices.some((line) => line.includes(`balance: address=${VERBOSE_ADDRESS}`))).toBe(true);
    expect(notices.filter((line) => line.includes(QUIET_ADDRESS))).toEqual([]);
  });

  it('a call after a verbose one is quiet', async () => {
    const verbose = await captureCommand(balanceCommand, parseArgs(['balance', VERBOSE_ADDRESS, '--verbose', ...UNREACHABLE]), ownCall({ host })).then(() => null, (err: unknown) => err);
    // It got as far as its first diagnostic, and failed connecting.
    expect(notices.some((line) => line.includes(`balance: address=${VERBOSE_ADDRESS}`))).toBe(true);
    notices = [];
    const quiet = await captureCommand(balanceCommand, parseArgs(['balance', QUIET_ADDRESS, ...UNREACHABLE]), ownCall({ host })).then(() => null, (err: unknown) => err);
    // It got as far too, failing the same way, past where the verbose one wrote its diagnostic.
    expect(quiet).toBeInstanceOf(Error);
    expect((quiet as Error).message).toBe((verbose as Error).message.replace(VERBOSE_ADDRESS, QUIET_ADDRESS));
    expect(notices.filter((line) => /\] \w+: /.test(line))).toEqual([]);
  });

  it("a library writes its diagnostics to the log of the call that reached it, and only a verbose call's shows them", async () => {
    const network: NetworkConfig = { indexer: 'http://test/indexer', indexerWS: 'ws://test/indexer/ws', node: 'ws://test/node', proofServer: 'http://test/proof', networkId: 'Undeployed' };
    // The chain's tip can't be read, which the repository notes as a diagnostic.
    const repo = new WalletDataRepository({
      fetchProtocolVersion: async () => 2001000n,
      fetchTip: async () => { throw new Error('node unreachable'); },
      fetchUnshielded: async () => ({ balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 }),
      cacheDir: home,
    });
    const verboseLines: string[] = [];
    const quietLines: string[] = [];
    await Promise.all([
      repo.unshielded('addr-verbose', network, { log: callDiagnostics(true, (line) => verboseLines.push(line)).line }),
      repo.unshielded('addr-quiet', network, { log: callDiagnostics(false, (line) => quietLines.push(line)).line }),
    ]);
    expect(verboseLines).toHaveLength(1);
    expect(verboseLines[0]).toContain('repo: tip unavailable; skipping memo for');
    expect(verboseLines[0]).toContain('addr-verbose');
    expect(quietLines).toEqual([]);
    expect(notices).toEqual([]);
  });
});
