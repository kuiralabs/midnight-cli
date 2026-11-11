// The wait a write makes, after its sync, for its three wallets to be past the
// chain's fork to ledger 9 (fork-crossing.ts): what crosses during it passes,
// what doesn't is reported with why. States are fed as the facade emits them
// (its `protocolVersion` record); the failures are the real ones mn raises.

import { describe, expect, it } from 'vitest';
import * as rx from 'rxjs';
import { BlockfrostLimitError, CancelledError, WalletBehindForkError } from '@kuiralabs/midnight-cli-core';
import { awaitWalletsPastFork, type WalletVersions } from '../fork-crossing.ts';

const PAST = 2_001_100n;
const GENESIS = 22_000n;
const at = (shielded: bigint, unshielded: bigint, dust: bigint): WalletVersions => ({ protocolVersion: { shielded, unshielded, dust } });

describe('waiting for the wallets to cross the fork', () => {
  it('ends at once when all three are past it', async () => {
    const statuses: string[] = [];
    await awaitWalletsPastFork(rx.of(at(PAST, PAST, PAST)), { report: {}, onStatus: (s) => statuses.push(s) });
    expect(statuses).toEqual([]);
  });

  it('passes the unshielded race: its version signal comes in the update after the sync ended', async () => {
    const states = new rx.BehaviorSubject(at(PAST, GENESIS, PAST));
    const waited = awaitWalletsPastFork(states, { report: {}, timeoutMs: 5_000 });
    setTimeout(() => states.next(at(PAST, PAST, PAST)), 50);
    await expect(waited).resolves.toBeUndefined();
  });

  it('says which wallet it waits for, every second', async () => {
    const states = new rx.BehaviorSubject(at(GENESIS, PAST, PAST));
    const statuses: string[] = [];
    const waited = awaitWalletsPastFork(states, { report: {}, timeoutMs: 5_000, onStatus: (s) => statuses.push(s) });
    setTimeout(() => states.next(at(PAST, PAST, PAST)), 1_200);
    await waited;
    expect(statuses[0]).toMatch(/^Waiting for the shielded wallet to sync past the chain's fork to ledger 9 \(\d+ s\)\.\.\.$/);
  });

  it('fails with WALLET_BEHIND_FORK naming only the wallets still behind, and why', async () => {
    const err = await awaitWalletsPastFork(new rx.BehaviorSubject(at(GENESIS, PAST, PAST)), { report: {}, timeoutMs: 1_100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WalletBehindForkError);
    const message = (err as Error).message;
    expect(message).toContain("the shielded wallet is at protocol version 22000 (it is still replaying the chain's shielded history)");
    expect(message).not.toContain('unshielded wallet is at');
  });

  it('says the unshielded wallet is waiting for a version from the indexer, not for shielded history', async () => {
    const err = await awaitWalletsPastFork(new rx.BehaviorSubject(at(PAST, GENESIS, PAST)), { report: {}, timeoutMs: 1_100 }).catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(WalletBehindForkError);
    expect(err.message).toContain("the unshielded wallet is at protocol version 22000 (the indexer hasn't reported a ledger-9 version to it yet)");
    expect(err.message).not.toContain('shielded history');
  });

  it('names a shielded read that failed, with it as the cause', async () => {
    const failure = new Error('socket hang up');
    const err = await awaitWalletsPastFork(new rx.BehaviorSubject(at(GENESIS, PAST, PAST)), { report: { shielded: { failure } }, timeoutMs: 1_100 }).catch((e: unknown) => e) as Error;
    expect(err).toBeInstanceOf(WalletBehindForkError);
    expect(err.cause).toBe(failure);
    expect(err.message).toContain('reading its shielded history first failed: socket hang up');
  });

  it('says a shielded read ran out of time, and where the next run resumes', async () => {
    const err = await awaitWalletsPastFork(new rx.BehaviorSubject(at(GENESIS, PAST, PAST)), {
      report: { shielded: { partial: { lastAppliedEventId: 1_803_195, maxId: 1_863_532 } } }, timeoutMs: 1_100,
    }).catch((e: unknown) => e) as Error;
    expect(err.message).toContain('reading its shielded history first ran out of time at event 1803195 of 1863532; the next run resumes there');
  });

  it('fails with the failed read itself when it carries a code of its own (a Blockfrost id over its limit)', async () => {
    const failure = new BlockfrostLimitError(402);
    const err = await awaitWalletsPastFork(new rx.BehaviorSubject(at(GENESIS, PAST, PAST)), { report: { shielded: { failure } }, timeoutMs: 1_100 }).catch((e: unknown) => e);
    expect(err).toBe(failure);
  });

  it('ends with CancelledError when cancelled', async () => {
    const controller = new AbortController();
    const waited = awaitWalletsPastFork(new rx.BehaviorSubject(at(GENESIS, PAST, PAST)), { report: {}, timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await expect(waited).rejects.toBeInstanceOf(CancelledError);
  });
});
