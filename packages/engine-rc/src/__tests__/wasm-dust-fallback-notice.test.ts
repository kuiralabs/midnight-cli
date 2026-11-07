// A hosted network's Dust is read through the native sidecar. When the read
// falls back to the in-process WASM reader, the host's notices say so, and
// why: the sidecar is turned off, or it failed (with its error). On the
// localnet the fallback stays in the verbose lines.
//
// The sidecar is an external process (a shell script stands in for it) and the
// indexer an external service (a WebSocket replaying real mainnet Dust events
// across its fork, fixtures/dust-events-mainnet-fork.json); the repository and
// mn's reader are real.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFromEnvironment, type NetworkConfig, type Settings } from '@kuiralabs/midnight-cli-core';
import { WalletDataRepository } from '../wallet-data-repository.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import fixture from './fixtures/dust-events-mainnet-fork.json';
import { startFakeEventIndexer, type FakeEventIndexer } from '../../../../test-support/fake-event-indexer.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';
import { testHost } from '../../../../test-support/test-host.ts';

type FixtureEvent = { id: number; protocolVersion: number; raw: string };
const events = [...(fixture.start as FixtureEvent[]), ...(fixture.fork as FixtureEvent[]).filter((e) => BigInt(e.protocolVersion) >= FORK_SCHEDULE.v9)];
const lastId = events.at(-1)!.id;
const SEED = Buffer.from('11'.repeat(32), 'hex');

let indexer: FakeEventIndexer;
let closed: number;
beforeAll(async () => {
  indexer = await startFakeEventIndexer('dustLedgerEvents', events.map((e) => ({ ...e, maxId: lastId })));
  closed = await closedPort();
});
afterAll(async () => { await indexer.close(); });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-wasm-notice-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const network = (networkId: string): NetworkConfig => ({
  indexer: `http://127.0.0.1:${closed}/api/v4/graphql`, indexerWS: indexer.url, node: `ws://127.0.0.1:${closed}`, proofServer: `http://127.0.0.1:${closed}`, networkId,
});

/** A sidecar that folds ledger 9 (it says so for --ledger) and fails every sync with `message`. */
function failingSidecar(message: string): string {
  const bin = join(dir, 'dust-sync');
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = "--ledger" ] && echo 9 && exit 0\necho "${message}" >&2\nexit 1\n`, { mode: 0o755 });
  return bin;
}

/** Reads the wallet's Dust on `networkId` with `settings`, and returns the notices the host was given. */
async function noticesOfDustRead(networkId: string, settings: Partial<Settings>): Promise<string[]> {
  const notices: string[] = [];
  const host = testHost({ settings: () => ({ ...settingsFromEnvironment(process.env), ...settings }), notice: (line) => notices.push(line) });
  const repo = new WalletDataRepository(host, {
    fetchProtocolVersion: async () => 2_001_100n,
    fetchTip: async () => 'tip',
    fetchChainId: async () => null,
    fetchEventTip: async () => lastId,
  });
  const view = await repo.dust(SEED, network(networkId), { root: join(dir, 'root'), notice: () => {} });
  expect(view.lastAppliedEventId, 'the WASM reader still reads the Dust').toBe(lastId);
  return notices;
}

describe('the WASM Dust fallback on a hosted network', () => {
  it('is said when the sidecar fails, with its error', async () => {
    const notices = await noticesOfDustRead('Preview', { isNativeDustOff: false, dustSyncBin: failingSidecar('indexer refused the subscription') });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Dust on preview is read in-process (WASM)');
    expect(notices[0]).toContain('the dust-sync sidecar failed: dust-sync exited 1: indexer refused the subscription');
  });

  it('is said when the sidecar is turned off, naming the setting', async () => {
    const notices = await noticesOfDustRead('PreProd', { isNativeDustOff: true });
    expect(notices).toEqual(['  Dust on preprod is read in-process (WASM), slower than the native dust-sync sidecar: the native sidecar is turned off (MN_DISABLE_NATIVE_DUST=1).']);
  });

  it('is not a notice on the localnet', async () => {
    expect(await noticesOfDustRead('Undeployed', { isNativeDustOff: false, dustSyncBin: failingSidecar('boom') })).toEqual([]);
  });
});
