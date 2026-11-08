// The wallet session over the rc engine's DApp connector, its facade stubbed
// at the SDK boundary: each operation answers in the session's own types, and
// closing reverts what was built but never submitted. A program opens one with
// openWalletSession, through its host's engine, listening for the SDK's
// warnings from the open until close().

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as rx from 'rxjs';
import { DustAddress, MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { sessionOver, type SessionSubmitBounds, type WalletSession, DustRequiredError, TransactionRefusedError, classifyError, createHost, createSdkWarningRouter, openWalletSession, type Engine, type OpenWalletSessionOptions } from '@kuiralabs/midnight-cli-core';
import type { OpenedConnector } from '@kuiralabs/midnight-cli-core/engine';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRcEngine } from '../index.ts';
import type { TransactionDetail } from '@kuiralabs/midnight-cli-core/engine';
import { deriveShieldedAddress, deriveUnshieldedAddress } from '../derive-address.ts';
import { NO_TERMINAL, TEST_NETWORK_CONFIG, connectorStub } from '../../../../test-support/connector-stub.ts';
import { createDAppConnector } from '../dapp-connector.ts';
import { FORK_SCHEDULE } from '../fork-schedule.ts';
import { agentPaysMerchant, unsealedBytes } from '../../../../test-support/ledger-tx.ts';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';
import { closedPort } from '../../../../test-support/closed-port.ts';

const { WALLET_SHIELDED, WALLET_UNSHIELDED, createBundleStub, mockState } = connectorStub({
  createDAppConnector, deriveShieldedAddress, DustAddress, UnshieldedAddress, ledger9ProtocolVersion: FORK_SCHEDULE.v9,
});

const NIGHT_RAW = '0000000000000000000000000000000000000000000000000000000000000000';
const OTHER_TOKEN = '02' + '00'.repeat(31);
const RECIPIENT = deriveUnshieldedAddress(Buffer.from('00'.repeat(31) + '42', 'hex'), 'undeployed');

/** A real unsealed ledger-9 dApp transaction, as hex. */
let AGENT_TX: string;
beforeAll(async () => {
  AGENT_TX = Buffer.from(await unsealedBytes(agentPaysMerchant())).toString('hex');
});

function openSession(options: { bundleOverrides?: Parameters<typeof createBundleStub>[0]; readTransaction?: (tx: string, stage: 'unsealed' | 'sealed') => TransactionDetail[]; submitBounds?: SessionSubmitBounds } = {}) {
  const bundle = createBundleStub({
    stateFn: () => rx.of(mockState({ unshieldedBalances: { [NIGHT_RAW]: 7_000_000n }, shieldedBalances: { [NIGHT_RAW]: 3n }, dustBalance: 42n })),
    ...options.bundleOverrides,
  });
  const revert = vi.fn().mockResolvedValue(undefined);
  (bundle.facade as unknown as { revert: typeof revert }).revert = revert;
  const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
  const stop = vi.fn(async () => { connector.dispose(); });
  const session: WalletSession = sessionOver('undeployed', { connector, stop }, options.readTransaction ?? (() => []), undefined, options.submitBounds);
  return { session, bundle, revert, stop };
}

describe('wallet session — a submit the node never finalizes', () => {
  // The SDK's submit against a node that went away: it never returns.
  const neverFinalized = () => new Promise<string>(() => {});

  it('stops waiting once the node stops answering: NETWORK_ERROR naming the node', async () => {
    const node = `ws://127.0.0.1:${await closedPort()}`;
    const { session } = openSession({ bundleOverrides: { submitTransaction: vi.fn(neverFinalized) }, submitBounds: { node } });
    const started = Date.now();
    const balanced = await session.balanceTransaction(AGENT_TX);
    await expect(session.submit(balanced)).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining(`The node at ${node} stopped answering while the transaction was submitted`) });
    // The node is asked every 10 s.
    expect(Date.now() - started).toBeLessThan(20_000);
    await session.close();
  }, 30_000);

  it('honours the session\'s cancellation: CANCELLED, before sending and while waiting', async () => {
    const controller = new AbortController();
    const submitTransaction = vi.fn(neverFinalized);
    const { session } = openSession({ bundleOverrides: { submitTransaction }, submitBounds: { signal: controller.signal } });
    const balanced = await session.balanceTransaction(AGENT_TX);
    const waiting = session.submit(balanced);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED', message: expect.stringContaining('it was sent and may still land') });
    await expect(session.submit(balanced)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(submitTransaction).toHaveBeenCalledOnce();
    await session.close();
  });
});

describe('wallet session', () => {
  it('names the wallet\'s addresses on its network', async () => {
    const { session } = openSession();
    const addresses = await session.addresses();
    expect(MidnightBech32m.parse(addresses.unshielded).decode(UnshieldedAddress, 'undeployed').equals(WALLET_UNSHIELDED.hexString)).toBe(true);
    expect(MidnightBech32m.parse(addresses.shielded).decode(ShieldedAddress, 'undeployed').coinPublicKeyString()).toBe(WALLET_SHIELDED.coinPublicKeyString());
    expect(addresses.shieldedCoinPublicKey).toBe(WALLET_SHIELDED.coinPublicKeyString());
    expect(addresses.shieldedEncryptionPublicKey).toBe(WALLET_SHIELDED.encryptionPublicKeyString());
    expect(addresses.dust.startsWith('mn_dust_undeployed1')).toBe(true);
    await session.close();
  });

  it('reads what the wallet holds', async () => {
    const { session } = openSession();
    expect(await session.balances()).toEqual({ unshielded: { [NIGHT_RAW]: 7_000_000n }, shielded: { [NIGHT_RAW]: 3n }, dust: 42n });
    await session.close();
  });

  it('balances a transaction and submits it, as hex', async () => {
    const submitTransaction = vi.fn().mockResolvedValue('the-hash');
    const { session, revert } = openSession({ bundleOverrides: { submitTransaction } });
    const balanced = await session.balanceTransaction(AGENT_TX);
    expect(balanced).toBe('abcd');
    expect(await session.submit(balanced)).toBe('the-hash');
    expect(submitTransaction).toHaveBeenCalledOnce();
    await session.close();
    // Submitted, so nothing is left to revert.
    expect(revert).not.toHaveBeenCalled();
  });

  it('builds a swap from what it gives and what it takes', async () => {
    const initSwap = vi.fn().mockResolvedValue({ type: 'SWAP' });
    const { session } = openSession({ bundleOverrides: { initSwap } });
    const tx = await session.swap(
      [{ kind: 'unshielded', type: NIGHT_RAW, value: 5n }],
      [{ kind: 'unshielded', type: OTHER_TOKEN, value: 9n, recipient: RECIPIENT }],
    );
    expect(tx).toBe('abcd');
    const [inputs, outputs, options] = initSwap.mock.calls[0]!;
    expect(inputs).toEqual({ unshielded: { [NIGHT_RAW]: 5n } });
    expect(outputs).toHaveLength(1);
    expect(outputs[0].type).toBe('unshielded');
    expect(outputs[0].outputs[0]).toMatchObject({ type: OTHER_TOKEN, amount: 9n });
    expect(options.payFees).toBe(true);
    await session.close();
  });

  it('makes an offer the taker pays for, paid to its own shielded address, which closing does not cancel', async () => {
    const initSwap = vi.fn().mockResolvedValue({ type: 'SWAP' });
    const { session, revert } = openSession({ bundleOverrides: { initSwap } });
    const give = { token: '00'.repeat(31) + '01', amount: 10n };
    const want = { token: '00'.repeat(31) + '02', amount: 7n };

    expect(await session.makeOffer(give, want)).toBe('abcd');
    const [inputs, outputs, options] = initSwap.mock.calls[0]!;
    expect(inputs).toEqual({ shielded: { [give.token]: 10n } });
    expect(outputs).toHaveLength(1);
    expect(outputs[0].type).toBe('shielded');
    expect(outputs[0].outputs[0]).toMatchObject({ type: want.token, amount: 7n });
    expect(outputs[0].outputs[0].receiverAddress.coinPublicKeyString()).toBe(WALLET_SHIELDED.coinPublicKeyString());
    expect(options.payFees).toBe(false);
    await session.close();
    expect(revert).not.toHaveBeenCalled();
  });

  it('signs data with the wallet\'s unshielded key', async () => {
    const { session } = openSession();
    expect(await session.sign('68656c6c6f', 'hex')).toEqual({ data: '68656c6c6f', signature: 'abcd1234signature', verifyingKey: '5678efghpubkey', scheme: 'schnorr_bip340' });
    await session.close();
  });

  it('reads a transaction through the engine', async () => {
    const readTransaction = vi.fn(() => [{ label: 'Type', value: 'Transfer' }]);
    const { session } = openSession({ readTransaction });
    expect(await session.readTransaction('beef', 'sealed')).toEqual([{ label: 'Type', value: 'Transfer' }]);
    expect(readTransaction).toHaveBeenCalledWith('beef', 'sealed');
    await session.close();
  });

  it('reverts on close what it built but never submitted, then stops the wallet', async () => {
    const { session, revert, stop } = openSession();
    await session.balanceTransaction(AGENT_TX);
    await session.close();
    expect(revert).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('refuses calls once closed, and closes once', async () => {
    const { session, stop } = openSession();
    await session.close();
    await session.close();
    expect(stop).toHaveBeenCalledOnce();
    await expect(session.balances()).rejects.toThrow('The wallet session is closed');
    await expect(session.readTransaction('beef', 'sealed')).rejects.toThrow('The wallet session is closed');
  });

  describe('the cold-start race before its first transaction', () => {
    // The SDK's refusal when its coin index isn't built yet, as the session met it live just after a Dust registration.
    const coldStart = () => Object.assign(new Error('Insufficient funds'), { _tag: 'Wallet.InsufficientFunds', tokenType: NIGHT_RAW, amount: 0n });
    const dustShortage = () => Object.assign(new Error('Insufficient Funds: could not balance dust'), { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' });
    const give = [{ kind: 'unshielded' as const, type: NIGHT_RAW, value: 5n }];
    const take = [{ kind: 'unshielded' as const, type: OTHER_TOKEN, value: 9n, recipient: RECIPIENT }];

    /** A wallet opened in this process whose swaps answer as `initSwap` says, and its stop. */
    function openedWith(initSwap: () => Promise<unknown>) {
      const bundle = createBundleStub({ initSwap });
      const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
      return { connector, stop: vi.fn(async () => { connector.dispose(); }) };
    }

    it('reopens the wallet and asks again, until the swap is built', async () => {
      const first = openedWith(() => Promise.reject(coldStart()));
      const second = openedWith(() => Promise.reject(coldStart()));
      const third = openedWith(() => Promise.resolve({ type: 'SWAP' }));
      const reopen = vi.fn().mockResolvedValueOnce(second).mockResolvedValueOnce(third);
      const messages: string[] = [];
      const session = sessionOver('undeployed', first, () => [], { reopen, onMessage: (m) => messages.push(m), delayMs: 0 });

      expect(await session.swap(give, take)).toBe('abcd');
      expect(reopen).toHaveBeenCalledTimes(2);
      expect(first.stop).toHaveBeenCalledOnce();
      expect(second.stop).toHaveBeenCalledOnce();
      expect(messages).toEqual(['Refreshing wallet state (attempt 2/5)...', 'Refreshing wallet state (attempt 3/5)...']);
      await session.close();
      expect(third.stop).toHaveBeenCalledOnce();
    });

    it('gives up after five attempts with the SDK\'s refusal, reported as the engine reports it', async () => {
      const reopen = vi.fn(async () => openedWith(() => Promise.reject(coldStart())));
      const session = sessionOver('undeployed', openedWith(() => Promise.reject(coldStart())), () => [], { reopen, delayMs: 0 });

      await expect(session.swap(give, take)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: 'Insufficient funds', cause: { _tag: 'Wallet.InsufficientFunds' } });
      expect(reopen).toHaveBeenCalledTimes(4);
      await session.close();
    });

    it('does not reopen once it has built a transaction, which reopening would revert under the caller', async () => {
      const initSwap = vi.fn().mockResolvedValueOnce({ type: 'SWAP' }).mockRejectedValue(coldStart());
      const reopen = vi.fn();
      const session = sessionOver('undeployed', openedWith(initSwap), () => [], { reopen, delayMs: 0 });

      await session.swap(give, take);
      // The first swap, built and not submitted, holds the coins: said so.
      await expect(session.swap(give, take)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: expect.stringContaining("1 other transaction of this wallet's, made here, holds coins") });
      expect(reopen).not.toHaveBeenCalled();
      await session.close();
    });

    it('does not reopen for a Dust shortage, which only waiting fixes', async () => {
      vi.useFakeTimers();
      try {
        const reopen = vi.fn();
        const session = sessionOver('undeployed', openedWith(() => Promise.reject(dustShortage())), () => [], { reopen, delayMs: 0 });

        // The connector waits for Dust between its own attempts; none comes.
        const failure = session.swap(give, take).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await failure).toBeInstanceOf(Error);
        expect(reopen).not.toHaveBeenCalled();
        await session.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // The connector answers as it answers a dApp; the session, a program's
  // wallet in this process, reports as the engine does.
  describe('its failures, as the engine reports them', () => {
    it("reports the node's refusal in the node's words, coded by its reason", async () => {
      const sdkFailure = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 115') })));
      sdkFailure.catch(() => {});
      const { session } = openSession({ bundleOverrides: { submitTransaction: () => sdkFailure } });
      const balanced = await session.balanceTransaction(AGENT_TX);

      const err = await session.submit(balanced).catch((e: Error) => e);

      expect(err).toBeInstanceOf(TransactionRefusedError);
      expect((err as Error).message).toBe('The node refused the transaction: 1010: Invalid Transaction: Custom error: 115');
      expect(classifyError(err as Error, CORE_CODES)).toStrictEqual({ errorCode: 'STALE_UTXO', exitCode: 6 });
      await session.close();
    });

    it('reports a fee the node refused as too low, which the wallet now prices higher, as FEE_REPRICED, not as a refusal', async () => {
      const refused = () => {
        const failure = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 138') })));
        failure.catch(() => {});
        return failure;
      };
      // The refused fee, priced again, is well within the wallet's Dust (42).
      const { session, bundle } = openSession({ bundleOverrides: { submitTransaction: refused, calculateTransactionFee: async () => 10n } });
      const balanced = await session.balanceTransaction(AGENT_TX);

      const err = await session.submit(balanced).catch((e: Error) => e);

      expect(err).toMatchObject({ code: 'FEE_REPRICED', fromBlocks: 3, toBlocks: 5 });
      expect(classifyError(err as Error, CORE_CODES)).toStrictEqual({ errorCode: 'FEE_REPRICED', exitCode: 6 });
      expect(bundle.feePricing.feeBlocksMargin).toBe(5);

      // Past the largest margin: FEE_TOO_LOW.
      bundle.feePricing.feeBlocksMargin = 8;
      const again = await session.submit(await session.balanceTransaction(AGENT_TX)).catch((e: Error) => e);
      expect(again).toMatchObject({ code: 'FEE_TOO_LOW', marginBlocks: 8 });
      await session.close();
    });

    it("reports the connector's Dust refusal as DUST_REQUIRED, in the connector's words", async () => {
      vi.useFakeTimers();
      try {
        const { session } = openSession({ bundleOverrides: { balanceUnboundTransaction: () => Promise.reject(new Error('No dust tokens found in the wallet state')) } });
        const failure = session.balanceTransaction(AGENT_TX).catch((e: Error) => e);
        await vi.advanceTimersByTimeAsync(10 * 3_000);
        const err = await failure;

        expect(err).toBeInstanceOf(DustRequiredError);
        expect((err as Error).message).toContain("The wallet has no Dust available that covers this transaction's fee (No dust tokens found in the wallet state)");
        expect(classifyError(err as Error, CORE_CODES)).toStrictEqual({ errorCode: 'DUST_REQUIRED', exitCode: 5 });
        await session.close();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// The error-code parity table's row for a program's wallet session (src/__tests__/error-code-parity.test.ts
// lists every typed error where mn throws it; this one is the rc engine's connector's own).
describe("a program's wallet session, in the error-code parity table", () => {
  it('reports a spent coin the node refused as STALE_UTXO, exit 6, as before codes were owned per package', async () => {
    const refusal = Effect.runPromise(Effect.fail(new SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 115') })));
    refusal.catch(() => {});
    const bundle = createBundleStub({ stateFn: () => rx.of(mockState({})), submitTransaction: () => refusal });
    (bundle.facade as unknown as { revert: () => Promise<void> }).revert = async () => {};
    const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
    const session = sessionOver('undeployed', { connector, stop: async () => { connector.dispose(); } }, () => []);
    const err = await (async () => {
      try {
        await session.submit(await session.balanceTransaction(Buffer.from(await unsealedBytes(agentPaysMerchant())).toString('hex')));
        return undefined;
      } catch (error) {
        return error as Error;
      } finally {
        await session.close();
      }
    })();
    expect(classifyError(err!, CORE_CODES)).toStrictEqual({ errorCode: 'STALE_UTXO', exitCode: 6 });
  });
});

// What a program calls: the session opened through its host's engine. The rc
// engine is real but for its wallet's openConnector, which syncs a facade: here
// it gives the engine's own DApp connector over the facade stubbed at the SDK
// boundary, as the tests above build it.
describe('openWalletSession', () => {
  const SEED = Buffer.from('00'.repeat(31) + '07', 'hex');
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mn-open-session-')); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A host's engines over the rc engine, its openConnector standing in; what it was asked, and how often its connector stopped. */
  function rcEngines(open: (options: Parameters<Engine['wallet']['openConnector']>[0]) => Promise<OpenedConnector> = async () => openedOverStub()) {
    const asked: Parameters<Engine['wallet']['openConnector']>[0][] = [];
    const host = createHost({
      paths: { stateRoot: root, home: root },
      engineLoader: async (_set, loading) => {
        const engine = createRcEngine(loading);
        return { ...engine, wallet: { ...engine.wallet, openConnector: (options) => { asked.push(options); return open(options); } } };
      },
    });
    return { engines: host.engines, asked };
  }
  let stops = 0;
  function openedOverStub(): OpenedConnector {
    const bundle = createBundleStub({ stateFn: () => rx.of(mockState({ unshieldedBalances: { [NIGHT_RAW]: 5n }, dustBalance: 1n })) });
    (bundle.facade as unknown as { revert: () => Promise<void> }).revert = async () => {};
    const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
    return { connector, stop: async () => { stops += 1; connector.dispose(); } };
  }
  const options = (engines: OpenWalletSessionOptions['engines'], more: Partial<OpenWalletSessionOptions> = {}): OpenWalletSessionOptions => ({
    seed: SEED, network: 'undeployed', root, notice: NO_TERMINAL.notice, engines, networkConfig: TEST_NETWORK_CONFIG, ...more,
  });

  it("opens the seed's wallet through the network's engine and stops it on close", async () => {
    const { engines, asked } = rcEngines();
    const before = stops;
    const session = await openWalletSession(options(engines, { dustWaitMs: 1234 }));
    expect(session.network).toBe('undeployed');
    expect(await session.balances()).toEqual({ unshielded: { [NIGHT_RAW]: 5n }, shielded: {}, dust: 1n });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ seed: SEED, root, network: 'undeployed', networkConfig: TEST_NETWORK_CONFIG, address: deriveUnshieldedAddress(SEED, 'undeployed'), syncMode: 'full', dustWaitMs: 1234 });
    await session.close();
    expect(stops).toBe(before + 1);
  });

  it("listens for the SDK's warnings from the open until close, as progress lines", async () => {
    const router = createSdkWarningRouter();
    const call = router.openCall();
    const said: string[] = [];
    let listeningWhileOpening = false;
    const { engines } = rcEngines(async () => {
      listeningWhileOpening = router.isListening();
      router.route(call.id, 'Wallet.Sync', 'Internal Server Error');
      return openedOverStub();
    });
    const session = await openWalletSession(options(engines, { sdkWarnings: call.warnings, onMessage: (line) => said.push(line) }));
    expect(listeningWhileOpening).toBe(true);
    router.route(call.id, 'Wallet.Indexer', 'socket closed');
    expect(router.isListening()).toBe(true);
    await session.close();
    expect(router.isListening()).toBe(false);
    router.route(call.id, 'Wallet.Sync', 'after close');
    expect(said.filter((line) => line.startsWith('SDK: '))).toEqual(['SDK: Internal Server Error', 'SDK: socket closed']);
  });

  it('listens with no listener when given no progress callback: the warnings are only taken', async () => {
    const router = createSdkWarningRouter();
    const call = router.openCall();
    const session = await openWalletSession(options(rcEngines().engines, { sdkWarnings: call.warnings }));
    expect(router.isListening()).toBe(true);
    await session.close();
    expect(router.isListening()).toBe(false);
  });

  it('stops listening when the open fails, and says why it failed', async () => {
    const router = createSdkWarningRouter();
    const call = router.openCall();
    const { engines } = rcEngines(async () => { throw new Error('the indexer refused'); });
    await expect(openWalletSession(options(engines, { sdkWarnings: call.warnings }))).rejects.toThrow('the indexer refused');
    expect(router.isListening()).toBe(false);
  });

  it('refuses a cancelled open before anything listens or opens', async () => {
    const router = createSdkWarningRouter();
    const call = router.openCall();
    const { engines, asked } = rcEngines();
    await expect(openWalletSession(options(engines, { sdkWarnings: call.warnings, signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: 'CancelledError' });
    expect(router.isListening()).toBe(false);
    expect(asked).toEqual([]);
  });
});
