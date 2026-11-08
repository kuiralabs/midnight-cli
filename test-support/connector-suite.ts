// The DApp connector's tests, over the SDK engine. The facade is stubbed at the SDK boundary (per CLAUDE.md: no mocks of our own
// code); the dApp's transactions are real ledger-9 transactions built with the
// engine's own copy of the ledger, and so are the finalized transactions the
// stub facade gives back. The rc SDK reads a dApp's transaction through its
// facade and waits for the ledger-9 fork.
//
// This file loads no engine: the test file that runs it passes one.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as rx from 'rxjs';
// The wallet SDK's copy of Effect: its submit runs on it.
import { Effect } from 'effect';
import { HISTORY, NO_TERMINAL, TEST_NETWORK_CONFIG, connectorStub, type BundleOverrides, type StubConnector, type StubEngine } from './connector-stub.ts';
import { startLocalIndexer, type LocalIndexer } from './local-indexer.ts';
import { ledgerTx, type Ledger } from './ledger-tx.ts';
import { SWAP_OFFER_HEX, OFFER_GIVE } from './fixtures/swap-offer.ts';
import { OfferCoinsInUseError, type OpenOffer, type RpcHandlerContext, classifyError, type NetworkName } from '@kuiralabs/midnight-cli-core';
import { createCoinPicking, NotAnOfferError, signedMessageBytes, PROOF_TIMEOUT_MS, toEngineError, withDustShortfall, type FeeLimits, type ApprovalOptions } from '@kuiralabs/midnight-cli-core/engine';
import type { SignatureVerifyingKey } from '@midnightntwrk/ledger-v9';
import { CORE_CODES } from './core-codes.ts';

/** What the suite takes from an engine. */
export interface ConnectorEngine extends StubEngine {
  /** The SDK set, as the suite's title names it. */
  set: string;
  signatureScheme(tag: string): string;
  toHistoryEntry(entry: any, segments?: readonly any[]): unknown;
  PartlySignedTransactionError: new () => Error;
  deriveUnshieldedAddress(seed: Buffer, network: NetworkName): string;
  deriveAllShieldedAddresses(seed: Buffer): Record<NetworkName, string>;
  MidnightBech32m: { parse(address: string): { decode(type: any, network: string): any }; encode(network: string, address: any): { asString(): string } };
  /** The engine's own copy of ledger-v9. */
  ledger: Ledger;
  createKeystore(secret: { kind: 'schnorr'; secret: Uint8Array }, network: string): { getPublicKey(): SignatureVerifyingKey; signDataAsync(data: Uint8Array): Promise<unknown> };
  SubmissionError: new (args: { message: string; cause?: unknown }) => Error;
  /** The hex of a transaction handle the engine passed to the facade. */
  handleHex(handle: any): string;
}

/** The connector's tests over `engine`. */
export function connectorSuite(engine: ConnectorEngine): void {
  const { NIGHT, WALLET_SK, AGENT_SK, WALLET_VK, spend, pay, buildTx, agentPaysMerchant, unsealedBytes, sealedBytes } = ledgerTx(engine.ledger);

  /** Sealed transactions to pay `n` Night, as bytes: what the stub facade finalizes, one per test that needs them told apart. */
  const SEALED = new Map<number, Uint8Array>();
  /** A finalized transaction handle as the SDK returns it, read with the engine's ledger. */
  const sealedTx = (n: number) => engine.ledger.Transaction.deserialize('signature', 'proof', 'binding', SEALED.get(n)!);
  const sealedHex = (n: number) => Buffer.from(SEALED.get(n)!).toString('hex');
  /** What the stub facade finalizes unless a test says otherwise: not the dApp's own transaction (100 Night), so the two are never confused. */
  const FINALIZED = 7;
  let FINALIZED_HEX: string;

  const { WALLET_SHIELDED, WALLET_UNSHIELDED, mockState, createBundleStub, createConnector } = connectorStub({ ...engine, finalized: () => sealedTx(FINALIZED) });

  /** Real undeployed addresses for a fixed seed, so outputs decode as they would from a dApp. */
  const RECIPIENT_SEED = Buffer.from('00'.repeat(31) + '42', 'hex');
  const UNSHIELDED_RECIPIENT = engine.deriveUnshieldedAddress(RECIPIENT_SEED, 'undeployed');
  const SHIELDED_RECIPIENT = engine.deriveAllShieldedAddresses(RECIPIENT_SEED).undeployed;


  /** Mock handler context with no-op notify */
  const ctx = (connectionId = 'conn_test'): RpcHandlerContext => ({ notify: vi.fn(), connectionId, requestId: 1, metadata: {} });

  // ── Tests ────────────────────────────────────────────────────────────

  /** A real unsealed ledger-9 dApp transaction (the agent pays from its own signed input), as hex. */
  let AGENT_TX: string;
  /** The same payment sealed (bound), as balanceSealedTransaction takes it. */
  let SEALED_AGENT_TX: string;

  beforeAll(async () => {
    AGENT_TX = Buffer.from(await unsealedBytes(agentPaysMerchant())).toString('hex');
    SEALED_AGENT_TX = Buffer.from(await sealedBytes(agentPaysMerchant())).toString('hex');
    for (const n of [1, 2, 3, 4, 5, 6, 9, FINALIZED]) SEALED.set(n, await sealedBytes(agentPaysMerchant(BigInt(n))));
    FINALIZED_HEX = sealedHex(FINALIZED);
  });

  describe(`dapp-connector (${engine.set} engine)`, () => {
    let connector: StubConnector | undefined;
    let origStderrWrite: typeof process.stderr.write;

    beforeEach(() => {
      origStderrWrite = process.stderr.write;
    });

    afterEach(() => {
      // Always restore stderr first, even if dispose throws
      process.stderr.write = origStderrWrite;
      connector?.dispose();
      connector = undefined;
    });

    describe('createDAppConnector', () => {
      it('throws for unknown networkId', () => {
        expect(() => createConnector({
          networkConfig: { ...TEST_NETWORK_CONFIG, networkId: 'Mainnet' },
        })).toThrow('Unknown networkId: Mainnet');
      });

      it('returns all 18 handler methods', () => {
        connector = createConnector();
        const methods = Object.keys(connector.handlers);
        expect(methods).toContain('connect');
        expect(methods).toContain('getUnshieldedBalances');
        expect(methods).toContain('getShieldedBalances');
        expect(methods).toContain('getDustBalance');
        expect(methods).toContain('getUnshieldedAddress');
        expect(methods).toContain('getShieldedAddresses');
        expect(methods).toContain('getDustAddress');
        expect(methods).toContain('getTxHistory');
        expect(methods).toContain('getConfiguration');
        expect(methods).toContain('getConnectionStatus');
        expect(methods).toContain('makeTransfer');
        expect(methods).toContain('submitTransaction');
        expect(methods).toContain('balanceUnsealedTransaction');
        expect(methods).toContain('balanceSealedTransaction');
        expect(methods).toContain('makeIntent');
        expect(methods).toContain('signData');
        expect(methods).toContain('getProvingProvider');
        expect(methods).toContain('hintUsage');
        expect(methods.length).toBe(18);
      });

      it('dispose() unsubscribes from state', () => {
        const subject = new rx.BehaviorSubject(mockState());
        connector = createConnector({
          bundleOverrides: { stateFn: () => subject.asObservable() },
        });
        expect(subject.observed).toBe(true);
        connector.dispose();
        expect(subject.observed).toBe(false);
        connector = undefined; // Already disposed
      });
    });

    // ── Handshake ──

    describe('connect', () => {
      it('returns networkId on match', async () => {
        connector = createConnector();
        const result = await connector.handlers.connect({ networkId: 'Undeployed' }, ctx());
        expect(result).toEqual({ networkId: 'Undeployed' });
      });

      it('matches case-insensitively', async () => {
        connector = createConnector();
        const result = await connector.handlers.connect({ networkId: 'undeployed' }, ctx());
        expect(result).toEqual({ networkId: 'Undeployed' });
      });

      it('throws InvalidRequest on network mismatch', async () => {
        connector = createConnector();
        await expect(connector.handlers.connect({ networkId: 'PreProd' }, ctx()))
          .rejects.toThrow('Network mismatch');
      });

      it('throws InvalidRequest when networkId is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.connect({}, ctx()))
          .rejects.toThrow('Network mismatch');
      });
    });

    // ── Read-Only Methods ──

    describe('getUnshieldedBalances', () => {
      it('returns balances from state', async () => {
        const balances = { 'token-a': 100n, 'token-b': 200n };
        connector = createConnector({
          bundleOverrides: { stateFn: () => rx.of(mockState({ unshieldedBalances: balances })) },
        });
        const result = await connector.handlers.getUnshieldedBalances({}, ctx());
        expect(result).toEqual(balances);
      });
    });

    describe('getShieldedBalances', () => {
      it('returns balances from state', async () => {
        const balances = { 'shielded-token': 999n };
        connector = createConnector({
          bundleOverrides: { stateFn: () => rx.of(mockState({ shieldedBalances: balances })) },
        });
        const result = await connector.handlers.getShieldedBalances({}, ctx());
        expect(result).toEqual(balances);
      });
    });

    describe('getDustBalance', () => {
      // Regression: the cap was the balance itself, hard-coded.
      it('returns { cap, balance }: the balance from state.dust.balance(), the cap what the unspent NIGHT generates at most', async () => {
        connector = createConnector({
          bundleOverrides: { stateFn: () => rx.of(mockState({
            dustBalance: 42000n,
            dustCoins: [{ maxCap: 100000n, dtime: undefined }, { maxCap: 50000n, dtime: undefined }, { maxCap: 70000n, dtime: new Date(0) }],
          })) },
        });
        const result = await connector.handlers.getDustBalance({}, ctx()) as any;
        expect(result.balance).toBe(42000n);
        expect(result.cap).toBe(150000n);
      });
    });

    describe('getTxHistory', () => {
      it('returns entries with correct TxStatus object shape', async () => {
        connector = createConnector();
        const result = await connector.handlers.getTxHistory({ pageNumber: 0, pageSize: 10 }, ctx()) as any[];
        expect(result).toEqual([
          { txHash: 'tx-hash-001', txStatus: { status: 'finalized', executionStatus: { 0: 'Success' } } },
          { txHash: 'tx-hash-002', txStatus: { status: 'discarded' } },
          { txHash: 'tx-hash-003', txStatus: { status: 'pending' } },
        ]);
      });

      it('paginates correctly', async () => {
        connector = createConnector();
        const result = await connector.handlers.getTxHistory({ pageNumber: 0, pageSize: 1 }, ctx()) as any[];
        expect(result).toHaveLength(1);
        expect(result[0].txHash).toBe('tx-hash-001');
      });

      it('returns page 2', async () => {
        connector = createConnector();
        const result = await connector.handlers.getTxHistory({ pageNumber: 1, pageSize: 1 }, ctx()) as any[];
        expect(result).toHaveLength(1);
        expect(result[0].txHash).toBe('tx-hash-002');
      });

      it.each([
        [{ pageNumber: -1 }, 'Invalid pageNumber: -1'],
        [{ pageNumber: 1.5 }, 'Invalid pageNumber: 1.5'],
        [{ pageNumber: '1' }, 'Invalid pageNumber: "1"'],
        [{ pageSize: 0 }, 'Invalid pageSize: 0'],
        [{ pageSize: -5 }, 'Invalid pageSize: -5'],
        [{ pageSize: 'all' }, 'Invalid pageSize: "all"'],
      ])('refuses paging %o as InvalidRequest before reading the history', async (paging, message) => {
        const history = vi.fn().mockResolvedValue(HISTORY);
        connector = createConnector({ bundleOverrides: { getAllFromTxHistory: history } });

        const err: any = await connector.handlers.getTxHistory(paging, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain(message);
        expect(history).not.toHaveBeenCalled();
      });

      it('returns an empty page past the end of the history', async () => {
        connector = createConnector();
        const result = await connector.handlers.getTxHistory({ pageNumber: 5, pageSize: 1 }, ctx());
        expect(result).toEqual([]);
      });

      describe('execution status of finalized transactions', () => {
        const finalized = (hash: string, status?: string) => ({
          hash, identifiers: [], ...(status ? { status } : {}),
          lifecycle: { status: 'finalized', finalizedBlock: { hash: 'b', height: 1, timestamp: new Date(0) } },
        });
        let indexer: LocalIndexer | undefined;
        afterEach(async () => { await indexer?.close(); indexer = undefined; });

        function connectorWith(history: unknown[], indexerUrl = TEST_NETWORK_CONFIG.indexer): StubConnector {
          return engine.createDAppConnector({
            notice: NO_TERMINAL.notice,
            bundle: createBundleStub({ getAllFromTxHistory: () => Promise.resolve(history as any[]) }),
            networkConfig: { ...TEST_NETWORK_CONFIG, indexer: indexerUrl },
            approvalOptions: { ...NO_TERMINAL, approveAll: true },
          });
        }

        it('reports a success as segment 0 succeeding and a failure as segment 0 failing, without asking the indexer', async () => {
          indexer = await startLocalIndexer(() => '{}');
          connector = connectorWith([finalized('ok', 'SUCCESS'), finalized('bad', 'FAILURE'), finalized('unknown')], indexer.url);

          const result = await connector.handlers.getTxHistory({}, ctx());

          expect(result).toEqual([
            { txHash: 'ok', txStatus: { status: 'finalized', executionStatus: { 0: 'Success' } } },
            { txHash: 'bad', txStatus: { status: 'finalized', executionStatus: { 0: 'Failure' } } },
            // No recorded outcome: none is claimed.
            { txHash: 'unknown', txStatus: { status: 'finalized', executionStatus: {} } },
          ]);
          expect(indexer.requests).toEqual([]);
        });

        it('reads a partial success\'s segments from the indexer, by the entry\'s hash', async () => {
          indexer = await startLocalIndexer(() => JSON.stringify({ data: { transactions: [{
            __typename: 'RegularTransaction',
            transactionResult: { status: 'PARTIAL_SUCCESS', segments: [{ id: 0, success: true }, { id: 1, success: true }, { id: 2, success: false }] },
          }] } }));
          connector = connectorWith([finalized('ok', 'SUCCESS'), finalized('partly', 'PARTIAL_SUCCESS')], indexer.url);

          const result = await connector.handlers.getTxHistory({}, ctx());

          expect(result).toEqual([
            { txHash: 'ok', txStatus: { status: 'finalized', executionStatus: { 0: 'Success' } } },
            { txHash: 'partly', txStatus: { status: 'finalized', executionStatus: { 0: 'Success', 1: 'Success', 2: 'Failure' } } },
          ]);
          expect(indexer.requests.map((r) => r.variables)).toEqual([{ hash: 'partly' }]);
        });

        it('fails as InternalError, naming the transaction, when the indexer cannot give a partial success\'s segments', async () => {
          connector = connectorWith([finalized('partly', 'PARTIAL_SUCCESS')], 'http://127.0.0.1:9/api/v4/graphql');

          const err: any = await connector.handlers.getTxHistory({}, ctx()).catch((e: any) => e);

          expect(err.code).toBe('InternalError');
          expect(err.message).toContain('segment results of transaction partly');
        });

        it('toHistoryEntry refuses a partial success without its segments rather than report it as anything else', () => {
          expect(() => engine.toHistoryEntry(finalized('partly', 'PARTIAL_SUCCESS') as any)).toThrow('segment results are missing');
          expect(() => engine.toHistoryEntry(finalized('partly', 'PARTIAL_SUCCESS') as any, [])).toThrow('segment results are missing');
        });
      });

      it('defaults to pageNumber 0 and pageSize 20', async () => {
        const many = Array.from({ length: 25 }, (_, i) => ({ ...HISTORY[2], hash: `h${i}` }));
        connector = createConnector({ bundleOverrides: { getAllFromTxHistory: () => Promise.resolve(many) } });
        const result = await connector.handlers.getTxHistory({}, ctx()) as any[];
        expect(result.map((e) => e.txHash)).toEqual(many.slice(0, 20).map((e) => e.hash));
      });
    });

    describe('getConfiguration', () => {
      it('maps NetworkConfig fields to Configuration shape', async () => {
        connector = createConnector();
        const result = await connector.handlers.getConfiguration({}, ctx()) as any;
        expect(result).toEqual({
          indexerUri: 'http://localhost:8088/api/v4/graphql',
          indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws',
          proverServerUri: 'http://localhost:6300',
          substrateNodeUri: 'ws://localhost:9944',
          networkId: 'Undeployed',
        });
      });
    });

    describe('getConnectionStatus', () => {
      it('returns connected status with the lowercase abstractions networkId', async () => {
        // Bech32m HRPs are lowercase and addresses are encoded with the lowercase
        // abstractions form ('undeployed'). getConnectionStatus must report the
        // same lowercase form so dApps that round-trip the value back into
        // setNetworkId() before decoding addresses don't see a case-mismatch.
        connector = createConnector();
        const result = await connector.handlers.getConnectionStatus({}, ctx());
        expect(result).toEqual({ status: 'connected', networkId: 'undeployed' });
      });
    });

    // ── Guard on transaction methods ──

    describe('transaction methods wait for the wallet', () => {
      const calls = (txHex: () => string) => [
        ['balanceUnsealedTransaction', () => ({ tx: txHex() })],
        ['balanceSealedTransaction', () => ({ tx: txHex() })],
        ['submitTransaction', () => ({ tx: txHex() })],
        ['makeTransfer', () => ({ desiredOutputs: [{ kind: 'unshielded', type: '00'.repeat(32), value: '1', recipient: 'x' }] })],
        ['makeIntent', () => ({ options: { intentId: 'random', payFees: true } })],
      ] as const;
      const expectFacadeUntouched = (bundle: any) => {
        expect(bundle.facade.adoptTransaction).not.toHaveBeenCalled();
        expect(bundle.facade.balanceUnboundTransaction).not.toHaveBeenCalled();
        expect(bundle.facade.transferTransaction).not.toHaveBeenCalled();
        expect(bundle.facade.initSwap).not.toHaveBeenCalled();
      };

      const v9 = engine.ledger9ProtocolVersion;
      // The rc SDK's facade reads a dApp's transaction at the lowest of the
      // three wallets' versions, so one wallet behind the fork would make it
      // read ledger-9 bytes as ledger 8.
      const DUST_BEHIND = { shielded: v9, unshielded: v9, dust: 1000300n };

      it.each(calls(() => AGENT_TX))('%s refuses as Disconnected, naming the wallet behind the ledger-9 fork, before touching the facade', async (method, params) => {
        const bundle = createBundleStub({ stateFn: () => rx.of(mockState({ protocolVersion: DUST_BEHIND })) });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await (connector.handlers as any)[method](params(), ctx()).catch((e: any) => e);

        expect(err.code).toBe('Disconnected');
        expect(err.message).toContain('still behind: dust at 1000300');
        expectFacadeUntouched(bundle);
      });

      it('accepts transactions once the lagging wallet crosses the fork', async () => {
        const states = new rx.BehaviorSubject(mockState({ protocolVersion: DUST_BEHIND }));
        const bundle = createBundleStub({ stateFn: () => states });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).rejects.toMatchObject({ code: 'Disconnected' });

        states.next(mockState());

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).resolves.toHaveProperty('tx');
      });

      it('does not require a strictly synced state, which an idle chain\'s dust wallet never reports', async () => {
        const bundle = createBundleStub({ stateFn: () => rx.of(mockState({ isSynced: false })) });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).resolves.toHaveProperty('tx');
      });
    });

    // ── State guard ──

    describe('state guard', () => {
      it('throws Disconnected when wallet not synced', async () => {
        const neverSynced = new rx.Subject<any>();
        connector = createConnector({
          bundleOverrides: { stateFn: () => neverSynced.asObservable() },
        });
        await expect(connector.handlers.getUnshieldedBalances({}, ctx()))
          .rejects.toThrow('Wallet not synced yet');
      });

      // On preprod through Blockfrost a server that said "ready" refused reads
      // for about 40 s: the wallet's next state the SDK calls synced came that late.
      it('answers at once from the state the caller\'s sync ended on', async () => {
        const quiet = new rx.Subject<any>();
        const synced = { unshielded: { balances: { ['00'.repeat(32)]: 5n } } };
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle: createBundleStub({ stateFn: () => quiet.asObservable() }),
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          initialState: synced as any,
        });
        expect(await connector.handlers.getUnshieldedBalances({}, ctx())).toEqual({ ['00'.repeat(32)]: 5n });
      });

      it('moves on to each later state that is current by the caller\'s rule, not only by the SDK\'s', async () => {
        const states = new rx.Subject<any>();
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle: createBundleStub({ stateFn: () => states.asObservable() }),
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          initialState: { unshielded: { balances: {} } } as any,
          isCurrent: (state: any) => state.caughtUp === true,
        });
        // Not synced by the SDK's rule (a wallet the caller didn't sync is behind), current by the caller's.
        states.next({ isSynced: false, caughtUp: true, unshielded: { balances: { ['00'.repeat(32)]: 7n } } });
        expect(await connector.handlers.getUnshieldedBalances({}, ctx())).toEqual({ ['00'.repeat(32)]: 7n });
        // Behind by the caller's rule: reads keep the last current state.
        states.next({ isSynced: false, caughtUp: false, unshielded: { balances: { ['00'.repeat(32)]: 9n } } });
        expect(await connector.handlers.getUnshieldedBalances({}, ctx())).toEqual({ ['00'.repeat(32)]: 7n });
      });

      it('throws Disconnected with correct error code', async () => {
        const neverSynced = new rx.Subject<any>();
        connector = createConnector({
          bundleOverrides: { stateFn: () => neverSynced.asObservable() },
        });
        try {
          await connector.handlers.getUnshieldedBalances({}, ctx());
          expect.unreachable('should have thrown');
        } catch (err: any) {
          expect(err.code).toBe('Disconnected');
          expect(err.type).toBe('DAppConnectorAPIError');
        }
      });
    });

    // ── Write method approval gating ──

    describe('write method approval', () => {
      it('proceeds when approveAll is true', async () => {
        connector = createConnector({ approvalOptions: { ...NO_TERMINAL, approveAll: true } });
        const result = await connector.handlers.signData({
          data: 'deadbeef',
          options: { encoding: 'hex', keyType: 'unshielded' },
        }, ctx()) as any;
        expect(result.data).toBe('deadbeef');
        expect(result.signature).toBe('abcd1234signature');
        expect(result.verifyingKey).toBe('5678efghpubkey');
      });

      // Regression: with no terminal, a write reached the dApp as "User rejected the request" though no one was asked.
      it('refuses as approval unavailable, not as a rejection, when stdin is not a TTY and no approveAll', async () => {
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        process.stderr.write = (() => true) as any;

        try {
          connector = createConnector({ approvalOptions: { ...NO_TERMINAL } });
          await expect(connector.handlers.signData({
            data: 'deadbeef',
            options: { encoding: 'hex', keyType: 'unshielded' },
          }, ctx())).rejects.toMatchObject({
            code: 'PermissionRejected',
            message: 'No one could be asked to approve the request: signData needs approval, and mn serve has no terminal to ask at. '
              + "Start mn serve with --approve-all to approve requests without asking (or --approve-fees for a wallet that only pays an agent's Dust fee), or run it at a terminal.",
            mnCode: 'APPROVAL_UNAVAILABLE',
          });
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      });

      it('refuses with PermissionRejected, the API\'s code for a permission not given', async () => {
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        process.stderr.write = (() => true) as any;

        try {
          connector = createConnector({ approvalOptions: { ...NO_TERMINAL } });
          try {
            await connector.handlers.submitTransaction({ tx: 'aabb' }, ctx());
            expect.unreachable('should have thrown');
          } catch (err: any) {
            expect(err.code).toBe('PermissionRejected');
            expect(err.type).toBe('DAppConnectorAPIError');
          }
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      });
    });

    // ── signData ──

    describe('signData', () => {
      it('refuses data that is not valid in its encoding before the operator is asked', async () => {
        // No approveAll and no TTY: reaching the approval step would fail as Rejected instead.
        connector = createConnector({ approvalOptions: { ...NO_TERMINAL } });
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
          const err: any = await connector.handlers.signData({ data: '@@@not base64@@@', options: { encoding: 'base64', keyType: 'unshielded' } }, ctx())
            .catch((e: any) => e);
          expect(err.code).toBe('InvalidRequest');
          expect(err.message).toBe('data is not valid base64 (standard alphabet, padded)');
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      });

      it('handles hex encoding', async () => {
        const bundle = createBundleStub();
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const result = await connector.handlers.signData({
          data: 'cafebabe',
          options: { encoding: 'hex', keyType: 'unshielded' },
        }, ctx()) as any;

        expect(result.data).toBe('cafebabe');
        expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
          signedMessageBytes(new Uint8Array([0xca, 0xfe, 0xba, 0xbe]))
        );
      });

      it('handles base64 encoding', async () => {
        const bundle = createBundleStub();
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const b64Data = Buffer.from('hello world').toString('base64');
        const result = await connector.handlers.signData({
          data: b64Data,
          options: { encoding: 'base64' },
        }, ctx()) as any;

        expect(result.data).toBe(b64Data);
        expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
          signedMessageBytes(new Uint8Array(Buffer.from('hello world')))
        );
      });

      it('handles text encoding', async () => {
        const bundle = createBundleStub();
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const result = await connector.handlers.signData({
          data: 'sign me',
          options: { encoding: 'text' },
        }, ctx()) as any;

        expect(result.data).toBe('sign me');
        expect((bundle.keystore as any).signDataAsync).toHaveBeenCalledWith(
          signedMessageBytes(new Uint8Array(Buffer.from('sign me', 'utf-8')))
        );
      });

      // The key that signs here also signs the wallet's unshielded spends, over a
      // transaction's signature data. Signed as given, a dApp could send that
      // signature data as its message and get back a valid spend signature.
      it('signs the prefixed message, so a transaction\'s signature data sent as data gives no spend signature', async () => {
        const keystore = engine.createKeystore({ kind: 'schnorr', secret: new Uint8Array(32).fill(1) }, 'undeployed');
        const vk = keystore.getPublicKey();
        expect(vk).toEqual(WALLET_VK);
        const intent = engine.ledger.Intent.new(new Date(Date.UTC(2030, 0, 1)));
        intent.guaranteedUnshieldedOffer = engine.ledger.UnshieldedOffer.new([spend(WALLET_SK, 990n)], [pay(990n)], []);
        const spendData = intent.signatureData(1);
        const bundle = createBundleStub();
        (bundle as any).keystore = keystore;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const result = await connector.handlers.signData({
          data: Buffer.from(spendData).toString('hex'), options: { encoding: 'hex', keyType: 'unshielded' },
        }, ctx()) as any;

        const signature = { tag: 'schnorr', value: result.signature } as never;
        expect(engine.ledger.verifySignature(vk, spendData, signature)).toBe(false);
        expect(engine.ledger.verifySignature(vk, signedMessageBytes(spendData), signature)).toBe(true);
        expect(result.data).toBe(Buffer.from(spendData).toString('hex'));
      });

      it('throws for unknown encoding', async () => {
        connector = createConnector();
        await expect(connector.handlers.signData({
          data: 'test',
          options: { encoding: 'binary' },
        }, ctx())).rejects.toThrow('Unknown encoding: binary');
      });

      it('throws for unsupported keyType', async () => {
        connector = createConnector();
        await expect(connector.handlers.signData({
          data: 'test',
          options: { encoding: 'text', keyType: 'shielded' },
        }, ctx())).rejects.toThrow('Unsupported keyType');
      });

      it('throws when data is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.signData({
          options: { encoding: 'hex' },
        }, ctx())).rejects.toThrow('data and options.encoding are required');
      });

      it('throws when encoding is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.signData({
          data: 'test',
          options: {},
        }, ctx())).rejects.toThrow('data and options.encoding are required');
      });

      it('returns the hex values and the scheme, not the SDK\'s { tag, value } objects', async () => {
        connector = createConnector();
        const result = await connector.handlers.signData({
          data: 'aabb',
          options: { encoding: 'hex' },
        }, ctx()) as any;
        expect(result).toEqual({
          data: 'aabb',
          signature: 'abcd1234signature',
          verifyingKey: '5678efghpubkey',
          scheme: 'schnorr_bip340',
        });
      });
    });

    // ── Input validation on write methods ──

    describe('input validation', () => {
      it('makeTransfer throws when desiredOutputs is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.makeTransfer({}, ctx()))
          .rejects.toThrow('desiredOutputs must be a non-empty array');
      });

      it('makeTransfer throws when desiredOutputs is empty', async () => {
        connector = createConnector();
        await expect(connector.handlers.makeTransfer({ desiredOutputs: [] }, ctx()))
          .rejects.toThrow('desiredOutputs must be a non-empty array');
      });

      it('makeTransfer throws for invalid output kind', async () => {
        connector = createConnector();
        await expect(connector.handlers.makeTransfer({
          desiredOutputs: [{ kind: 'public', type: '0000', value: '100', recipient: 'addr' }],
        }, ctx())).rejects.toThrow('Invalid output kind: "public"');
      });

      // A dApp's mistakes in what it asks for are InvalidRequest, refused before
      // the operator is prompted and before the wallet builds anything.
      const output = (o: Record<string, unknown>) => ({ kind: 'unshielded', type: NIGHT, value: '5', recipient: UNSHIELDED_RECIPIENT, ...o });
      /** No approveAll and no TTY: reaching the approval step would fail as Rejected instead. */
      async function withoutOperator<T>(run: () => Promise<T>): Promise<T> {
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
          return await run();
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      }

      it.each([
        ['a zero value', output({ value: '0' }), 'Invalid value: 0 — must be greater than 0'],
        ['a negative value', output({ value: '-1' }), 'Invalid value: -1 — must be greater than 0'],
        ['a fractional value', output({ value: '1.5' }), 'Invalid value: "1.5" — must be a whole number'],
        ['a value that is not a number', output({ value: 'lots' }), 'Invalid value: "lots"'],
        ['a boolean value, which BigInt would read as 1', output({ value: true }), 'Invalid value: "true"'],
        ['a token type that is not 32 bytes of hex', output({ type: '0000' }), 'Invalid token type: "0000"'],
        ['a recipient that is not an address', output({ recipient: 'bob' }), 'Invalid recipient: "bob" is not an unshielded address on Undeployed'],
        ['a shielded address for an unshielded output', output({ recipient: SHIELDED_RECIPIENT }), 'is not an unshielded address on Undeployed'],
        ['an unshielded address for a shielded output', output({ kind: 'shielded' }), 'is not a shielded address on Undeployed'],
        ['an address for another network', output({ recipient: engine.deriveUnshieldedAddress(RECIPIENT_SEED, 'preprod') }), 'is not an unshielded address on Undeployed'],
      ])('makeTransfer refuses %s as InvalidRequest without prompting', async (_name, desired, message) => {
        const transfer = vi.fn();
        const c = connector = createConnector({ bundleOverrides: { transferTransaction: transfer }, approvalOptions: { ...NO_TERMINAL } });

        const err: any = await withoutOperator(() => c.handlers.makeTransfer({ desiredOutputs: [desired] }, ctx()).catch((e: any) => e));

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain(message);
        expect(transfer).not.toHaveBeenCalled();
      });

      it('makeTransfer passes a valid output to the wallet as a decoded address and a bigint', async () => {
        const transfer = vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' });
        connector = createConnector({ bundleOverrides: { transferTransaction: transfer } });

        await connector.handlers.makeTransfer({ desiredOutputs: [output({})] }, ctx()).catch(() => undefined);

        const [[combined]] = transfer.mock.calls;
        expect(combined).toEqual([{ type: 'unshielded', outputs: [{ type: NIGHT, receiverAddress: expect.anything(), amount: 5n }] }]);
      });

      it.each([
        ['an input kind that is neither', { kind: 'public', type: NIGHT, value: '5' }, 'Invalid input kind: "public"'],
        ['a zero input value', { kind: 'unshielded', type: NIGHT, value: '0' }, 'Invalid value: 0'],
        ['an input token type that is not hex', { kind: 'unshielded', type: 'night', value: '5' }, 'Invalid token type: "night"'],
      ])('makeIntent refuses %s as InvalidRequest without building a swap', async (_name, input, message) => {
        const initSwap = vi.fn();
        const c = connector = createConnector({ bundleOverrides: { initSwap }, approvalOptions: { ...NO_TERMINAL } });

        const err: any = await withoutOperator(() => c.handlers.makeIntent({
          desiredInputs: [input], desiredOutputs: [], options: { intentId: 'random', payFees: true },
        }, ctx()).catch((e: any) => e));

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain(message);
        expect(initSwap).not.toHaveBeenCalled();
      });

      it('submitTransaction throws when tx is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.submitTransaction({}, ctx()))
          .rejects.toThrow('tx is required');
      });

      it('balanceUnsealedTransaction throws when tx is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.balanceUnsealedTransaction({}, ctx()))
          .rejects.toThrow('tx is required');
      });

      it('balanceSealedTransaction throws when tx is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.balanceSealedTransaction({}, ctx()))
          .rejects.toThrow('tx is required');
      });

      it('makeIntent throws when options is missing', async () => {
        connector = createConnector();
        await expect(connector.handlers.makeIntent({
          desiredInputs: [],
          desiredOutputs: [],
        }, ctx())).rejects.toThrow('options is required for makeIntent');
      });
    });

    // ── Reading the dApp's transaction (the fee-wallet seam) ──

    describe('transaction adoption', () => {
      it.each([
        ['balanceUnsealedTransaction', 'Unbound', 'balanceUnboundTransaction'],
        ['balanceSealedTransaction', 'Finalized', 'balanceFinalizedTransaction'],
      ] as const)('%s reads the hex at stage %s and balances that handle', async (method, stage, sdkMethod) => {
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
        const bundle = createBundleStub({ [sdkMethod]: balance });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
        const tx = stage === 'Unbound' ? AGENT_TX : SEALED_AGENT_TX;

        await connector.handlers[method]({ tx }, ctx());

        expect(bundle.facade.adoptTransaction).toHaveBeenCalledWith(Uint8Array.from(Buffer.from(tx, 'hex')), stage);
        const [call] = balance.mock.calls;
        expect(engine.handleHex(call![0])).toBe(tx);
        expect(call!.at(-1)).toMatchObject({ ttl: expect.any(Date) });
      });

      it('submitTransaction reads the hex as a finalized transaction and submits that handle', async () => {
        const submit = vi.fn().mockResolvedValue('tx-id');
        const bundle = createBundleStub({ submitTransaction: submit });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const result = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx());

        expect(bundle.facade.adoptTransaction).toHaveBeenCalledWith(Uint8Array.from(Buffer.from(SEALED_AGENT_TX, 'hex')), 'Finalized');
        expect(submit).toHaveBeenCalledTimes(1);
        expect(engine.handleHex(submit.mock.calls[0]![0])).toBe(SEALED_AGENT_TX);
        expect(result).toEqual({ txHash: 'tx-id' });
      });

      it("forwards the node's refusal when the wallet SDK's submit fails, not only its own wrapper's words", async () => {
        // The wallet SDK runs its Effect submit with Effect.runPromise, which
        // rejects with a FiberFailure: the SubmissionError it failed with, and
        // the node's answer that error wraps, are under a symbol, not `cause`.
        const nodeAnswer = new Error('1010: Invalid Transaction: Custom error: 139');
        const sdkFailure = Effect.runPromise(Effect.fail(new engine.SubmissionError({ message: 'Transaction submission error', cause: nodeAnswer })));
        sdkFailure.catch(() => {});
        const bundle = createBundleStub({ submitTransaction: () => sdkFailure });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.message).toContain('Transaction submission error');
        expect(err.message).toContain('1010: Invalid Transaction: Custom error: 139');
        // Marked with mn's code for any refusal, its message and causes as the dApp reads them.
        expect(err.mnCode).toBe('TX_REJECTED');
        expect(err.code).toBeUndefined();
      });

      it.each([
        ['1010: Invalid Transaction: Custom error: 115', 'STALE_UTXO'],
        ['1010: Invalid Transaction: Custom error: 170', 'INVALID_DUST_PROOF'],
      ])("marks the node's refusal \"%s\" with mn's code %s", async (reason, mnCode) => {
        const sdkFailure = Effect.runPromise(Effect.fail(new engine.SubmissionError({ message: 'Transaction submission error', cause: new Error(reason) })));
        sdkFailure.catch(() => {});
        const bundle = createBundleStub({ submitTransaction: () => sdkFailure });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.message).toContain(reason);
        expect(err.mnCode).toBe(mnCode);
      });

      it('reports bytes the wallet cannot read as InvalidRequest, naming the stage, without balancing', async () => {
        const balance = vi.fn();
        const bundle = createBundleStub({ balanceUnboundTransaction: balance });
        // The rc SDK's reader, as it refuses another ledger version's bytes.
        (bundle.facade as any).adoptTransaction = () => { throw new Error('unknown tag midnight:transaction[v99]'); };
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: 'aabb' }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain('stage Unbound');
        expect(err.message).toContain('unknown tag midnight:transaction[v99]');
        expect(balance).not.toHaveBeenCalled();
      });

      it('rejects non-hex input before it reaches the SDK', async () => {
        const bundle = createBundleStub();
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: 'not-hex' }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(bundle.facade.adoptTransaction).not.toHaveBeenCalled();
      });
    });

    describe('a fee the node refuses as too low (error 138)', () => {
      /** The SDK's submit failing as it does when the node refuses the Dust payment as short of the fee. */
      const feeRefused = () => {
        const failure = Effect.runPromise(Effect.fail(new engine.SubmissionError({ message: 'Transaction submission error', cause: new Error('1010: Invalid Transaction: Custom error: 138') })));
        failure.catch(() => {});
        return failure;
      };
      const DUST = 10n ** 15n;
      /** A wallet holding `dust` and a refused transaction whose fee, priced with the wallet's margin as it is when asked, is 0.5 DUST times 1.05 per block. */
      const refusingWallet = (dust: bigint) => {
        const priced: number[] = [];
        const bundle = createBundleStub({
          submitTransaction: () => feeRefused(),
          stateFn: () => rx.of(mockState({ dustBalance: dust })),
          calculateTransactionFee: async () => {
            priced.push(bundle.feePricing.feeBlocksMargin);
            return (DUST / 2n) * 105n ** BigInt(bundle.feePricing.feeBlocksMargin) / 100n ** BigInt(bundle.feePricing.feeBlocksMargin);
          },
        });
        return { bundle, priced };
      };

      it('with Dust that covers the fee, raises the margin and asks the dApp to balance again (FEE_REPRICED)', async () => {
        const { bundle, priced } = refusingWallet(10n * DUST);
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('FEE_REPRICED');
        expect(err.message).toBe('The node refused the fee as too low (priced with 3 blocks of margin). The wallet now prices fees with 5 blocks: balance the transaction again and submit it.');
        // The refused fee was priced with the next margin, and the wallet keeps it for the next balance.
        expect(priced).toEqual([5]);
        expect(bundle.feePricing.feeBlocksMargin).toBe(5);
      });

      it('with Dust that does not cover it, leaves the margin and reports the refusal as before', async () => {
        const { bundle } = refusingWallet(DUST / 10n);
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.mnCode).toBe('TX_REJECTED');
        expect(err.message).toContain('Custom error: 138');
        expect(bundle.feePricing.feeBlocksMargin).toBe(3);
      });

      it('past the largest margin, fails with FEE_TOO_LOW naming the fee and the margin', async () => {
        const { bundle } = refusingWallet(10n * DUST);
        bundle.feePricing.feeBlocksMargin = 8;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('FEE_TOO_LOW');
        expect(err.message).toContain('(0.738727721894531 DUST, priced with 8 blocks of margin, the most mn tries)');
      });

      it('goes back to the first margin once a transaction goes through', async () => {
        const bundle = createBundleStub({ submitTransaction: vi.fn().mockResolvedValue('tx-id') });
        bundle.feePricing.feeBlocksMargin = 5;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await connector.handlers.submitTransaction({ tx: SEALED_AGENT_TX }, ctx());

        expect(bundle.feePricing.feeBlocksMargin).toBe(3);
      });
    });

    describe('signatureScheme', () => {
      it('names BIP-340 Schnorr, and refuses any other tag rather than mislabel it', () => {
        expect(engine.signatureScheme('schnorr')).toBe('schnorr_bip340');
        expect(() => engine.signatureScheme('ecdsa')).toThrow('mn signs with BIP-340 Schnorr only');
      });
    });

    // ── Address methods ──

    describe('getUnshieldedAddress', () => {
      it('returns bech32m-encoded unshielded address', async () => {
        connector = createConnector();
        const result = await connector.handlers.getUnshieldedAddress({}, ctx()) as any;
        expect(result.unshieldedAddress).toMatch(/^mn_addr_undeployed1/);
        expect(engine.MidnightBech32m.parse(result.unshieldedAddress).decode(engine.UnshieldedAddress, 'undeployed').equals(WALLET_UNSHIELDED.hexString)).toBe(true);
      });
    });

    describe('getShieldedAddresses', () => {
      it('returns shielded address and public keys', async () => {
        connector = createConnector();
        const result = await connector.handlers.getShieldedAddresses({}, ctx()) as any;
        expect(result.shieldedAddress).toBe(engine.MidnightBech32m.encode('undeployed', WALLET_SHIELDED).asString());
        expect(result.shieldedAddress).toMatch(/^mn_shield-addr_undeployed1/);
        expect(result.shieldedCoinPublicKey).toBe(WALLET_SHIELDED.coinPublicKeyString());
        expect(result.shieldedEncryptionPublicKey).toBe(WALLET_SHIELDED.encryptionPublicKeyString());
      });
    });

    describe('getDustAddress', () => {
      it('returns bech32m-encoded dust address', async () => {
        connector = createConnector();
        const result = await connector.handlers.getDustAddress({}, ctx()) as any;
        expect(result.dustAddress).toMatch(/^mn_dust_undeployed1/);
        expect(engine.MidnightBech32m.parse(result.dustAddress).decode(engine.DustAddress, 'undeployed').data).toBe(7n);
      });
    });

    // ── processRecipe (tested via write methods) ──

    describe('processRecipe', () => {
      it('rejects with timeout error when proof generation fails', async () => {
        // Tests the error path through processRecipe — finalizeRecipe rejection
        // propagates correctly through Promise.race and surfaces to the caller.
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            finalizeRecipe: () => Promise.reject(new Error('ZK proof generation timed out')),
          },
        });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()))
          .rejects.toThrow('ZK proof generation timed out');
      });

      it('returns serialized tx when finalizeRecipe resolves', async () => {
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            finalizeRecipe: () => Promise.resolve(sealedTx(6)),
          },
        });

        const result = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()) as any;
        expect(result.tx).toBe(sealedHex(6));
      });

      it('propagates signRecipe errors', async () => {
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            signRecipe: () => Promise.reject(new Error('signing failed')),
          },
        });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()))
          .rejects.toThrow('signing failed');
      });

      it('propagates finalizeRecipe errors', async () => {
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            finalizeRecipe: () => Promise.reject(new Error('proof generation failed')),
          },
        });

        await expect(connector.handlers.balanceSealedTransaction({ tx: SEALED_AGENT_TX }, ctx()))
          .rejects.toThrow('proof generation failed');
      });
    });

    // ── getProvingProvider ──

    describe('getProvingProvider', () => {
      it('returns proof server URI', async () => {
        connector = createConnector();
        const result = await connector.handlers.getProvingProvider({}, ctx()) as any;
        expect(result.provingProvider).toBe('ready');
        expect(result.proverServerUri).toBe('http://localhost:6300');
      });
    });

    // ── hintUsage ──

    describe('hintUsage', () => {
      it('resolves without error', async () => {
        process.stderr.write = (() => true) as any;

        connector = createConnector();
        const result = await connector.handlers.hintUsage({
          methodNames: ['getUnshieldedBalances', 'makeTransfer'],
        }, ctx());
        expect(result).toBeUndefined();
      });

      it('resolves for a method this wallet does not know, as the spec asks', async () => {
        process.stderr.write = (() => true) as any;
        connector = createConnector();
        await expect(connector.handlers.hintUsage({ methodNames: ['someFutureMethod'] }, ctx())).resolves.toBeUndefined();
      });

      it.each([
        ['a string instead of an array', 'makeTransfer'],
        ['a non-string entry', ['makeTransfer', 42]],
        ['a name carrying terminal escape codes', ['\u001b[2Jcleared']],
      ])('refuses %s as InvalidRequest without printing it', async (_name, methodNames) => {
        const written: string[] = [];
        process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as any;
        connector = createConnector();

        const err: any = await connector.handlers.hintUsage({ methodNames }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toBe('methodNames must be an array of connector method names');
        expect(written.join('')).not.toContain('hints usage');
      });
    });

    // ── Dust retry ──

    describe('withDustRetry', () => {
      it('retries on "No dust tokens" error and succeeds', async () => {
        vi.useFakeTimers();
        process.stderr.write = (() => true) as any;
        let callCount = 0;
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            balanceUnboundTransaction: () => {
              callCount++;
              if (callCount === 1) return Promise.reject(new Error('No dust tokens found in the wallet state'));
              return Promise.resolve({ type: 'UNBOUND' });
            },
          },
        });

        const promise = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
        await vi.advanceTimersByTimeAsync(3_100);
        const result = await promise as any;
        expect(result.tx).toBeDefined();
        expect(callCount).toBe(2);
        vi.useRealTimers();
      });

      it('retries on wallet-sdk 2.0\'s tagged dust shortage', async () => {
        vi.useFakeTimers();
        process.stderr.write = (() => true) as any;
        const dustShortage = Object.assign(new Error('Insufficient Funds: could not balance dust'), {
          _tag: 'Wallet.InsufficientFunds', tokenType: 'dust',
        });
        let callCount = 0;
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            balanceUnboundTransaction: () => (++callCount === 1 ? Promise.reject(dustShortage) : Promise.resolve({ type: 'UNBOUND' })),
          },
        });

        const promise = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
        await vi.advanceTimersByTimeAsync(3_100);
        await promise;
        expect(callCount).toBe(2);
        vi.useRealTimers();
      });

      it('does not wait for dust when the wallet is short of NIGHT, which dust cannot fix', async () => {
        process.stderr.write = (() => true) as any;
        const nightShortage = Object.assign(new Error('Insufficient Funds: could not balance 00'), {
          _tag: 'Wallet.InsufficientFunds', tokenType: '00',
        });
        const balance = vi.fn().mockRejectedValue(nightShortage);
        connector = createConnector({ approvalOptions: { ...NO_TERMINAL, approveAll: true }, bundleOverrides: { balanceUnboundTransaction: balance } });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).rejects.toBe(nightShortage);
        expect(balance).toHaveBeenCalledTimes(1);
      });

      it('does not retry on non-dust errors', async () => {
        process.stderr.write = (() => true) as any;
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            balanceUnboundTransaction: () => Promise.reject(new Error('some other error')),
          },
        });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()))
          .rejects.toThrow('some other error');
      });

      it('fails after max retry attempts', async () => {
        vi.useFakeTimers();
        process.stderr.write = (() => true) as any;
        let callCount = 0;
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            balanceUnboundTransaction: () => {
              callCount++;
              return Promise.reject(new Error('No dust tokens found in the wallet state'));
            },
          },
        });

        const failure = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: any) => e);
        await vi.advanceTimersByTimeAsync(9 * 3_000);
        const err: any = await failure;
        expect(err.code).toBe('InternalError');
        // Nothing is reserved on this server, so the message doesn't send the caller waiting for a reservation to clear.
        expect(err.message).toContain('The wallet has no Dust available that covers this transaction\'s fee (No dust tokens found in the wallet state)');
        expect(err.message).toContain('no balanced transaction is holding any back on this server');
        expect(err.message).not.toContain('Retry once they settle');
        expect(classifyError(toEngineError(err) as Error, CORE_CODES).errorCode).toBe('DUST_REQUIRED');
        expect(err.mnCode).toBe('DUST_REQUIRED');
        expect(callCount).toBe(10); // DUST_RETRY_ATTEMPTS = 10
        vi.useRealTimers();
      });

      describe('a shortage that says what the fee takes', () => {
        // The wallet's own fee planner marks a shortage with the Dust the fee
        // takes. This wallet holds 0.35 DUST and generates 0.0075 a second, as
        // a 900 NIGHT wallet on a local ledger-9 chain does.
        const SPECK = 1_000_000_000_000_000n;
        const HAS = 350n * SPECK / 1000n;
        const PER_SECOND = 75n * SPECK / 10_000n;
        const shortOf = (needed: bigint, available = HAS) => withDustShortfall(Object.assign(new Error('Insufficient Funds: could not balance dust'), {
          _tag: 'Wallet.InsufficientFunds', tokenType: 'dust',
        }), { needed, available });
        /** A wallet state whose Dust grows from HAS at PER_SECOND, counted from when the test starts. */
        const growingFrom = (start: number) => () => rx.of({
          ...mockState(),
          dust: { balance: (at: Date) => HAS + PER_SECOND * BigInt(Math.max(0, Math.floor((at.getTime() - start) / 1000))), availableCoins: [{}], address: 'dust' },
        });

        it('waits the time the wallet takes to generate the rest, then pays', async () => {
          vi.useFakeTimers();
          const written: string[] = [];
          // 1 DUST: 0.65 more and a little over, 89 seconds at this rate.
          const balance = vi.fn().mockRejectedValueOnce(shortOf(SPECK)).mockResolvedValue({ type: 'UNBOUND' });
          connector = createConnector({ bundleOverrides: { stateFn: growingFrom(Date.now()), balanceUnboundTransaction: balance }, notice: (line) => written.push(line) });

          const paid = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
          await vi.advanceTimersByTimeAsync(88_000);
          expect(balance).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1_500);
          await paid;
          expect(balance).toHaveBeenCalledTimes(2);
          expect(written.join('')).toContain('Dust: 0.35 of the 1.00 DUST this fee takes; waiting about 2 minutes for the rest...');
          vi.useRealTimers();
        });

        it('refuses at once, with the time, when that is longer than a request waits', async () => {
          process.stderr.write = (() => true) as any;
          // 2 DUST: 1.65 more, close to four minutes, past the two a request waits.
          const balance = vi.fn().mockRejectedValue(shortOf(2n * SPECK));
          connector = createConnector({ bundleOverrides: { stateFn: growingFrom(Date.now()), balanceUnboundTransaction: balance } });

          const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: any) => e);
          expect(balance).toHaveBeenCalledTimes(1);
          expect(err.code).toBe('InternalError');
          expect(err.message).toBe(
            "Not enough Dust available for this transaction's fee: the wallet has 0.35 DUST and the fee takes 2.00. "
            + 'Its registered NIGHT generates the rest in about 4 minutes: retry then, or register more NIGHT to get there sooner.');
          expect(classifyError(toEngineError(err) as Error, CORE_CODES).errorCode).toBe('DUST_REQUIRED');
          expect(err.mnCode).toBe('DUST_REQUIRED');
        });

        it('waits longer when the caller allows it', async () => {
          vi.useFakeTimers();
          process.stderr.write = (() => true) as any;
          const balance = vi.fn().mockRejectedValueOnce(shortOf(2n * SPECK)).mockResolvedValue({ type: 'UNBOUND' });
          connector = engine.createDAppConnector({
            notice: NO_TERMINAL.notice,
            bundle: createBundleStub({ stateFn: growingFrom(Date.now()), balanceUnboundTransaction: balance }),
            networkConfig: TEST_NETWORK_CONFIG,
            approvalOptions: { ...NO_TERMINAL, approveAll: true },
            dustWaitMs: 5 * 60_000,
          });

          const paid = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
          await vi.advanceTimersByTimeAsync(226_000);
          await paid;
          expect(balance).toHaveBeenCalledTimes(2);
          vi.useRealTimers();
        });

        it('says so when the wallet will not generate the fee within a day', async () => {
          process.stderr.write = (() => true) as any;
          const balance = vi.fn().mockRejectedValue(shortOf(1_000n * SPECK));
          connector = createConnector({ bundleOverrides: { stateFn: growingFrom(Date.now()), balanceUnboundTransaction: balance } });

          const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: any) => e);
          expect(err.message).toContain("the wallet has 0.35 DUST and the fee takes 1000.00. Its registered NIGHT won't generate that within a day");
          expect(balance).toHaveBeenCalledTimes(1);
        });

        it('waits for what the wallet was short by on its own clock, which this machine\'s can run ahead of', async () => {
          vi.useFakeTimers();
          process.stderr.write = (() => true) as any;
          // The wallet spends by the chain's clock, 28 seconds behind: its coin held 0.14 DUST when the balance here read 0.35.
          const behind = HAS - 28n * PER_SECOND;
          const balance = vi.fn().mockRejectedValueOnce(shortOf(SPECK, behind)).mockResolvedValue({ type: 'UNBOUND' });
          connector = createConnector({ bundleOverrides: { stateFn: growingFrom(Date.now()), balanceUnboundTransaction: balance } });

          const paid = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
          await vi.advanceTimersByTimeAsync(116_000); // 0.86 more and a little over: 117 seconds
          expect(balance).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1_500);
          await paid;
          expect(balance).toHaveBeenCalledTimes(2);
          vi.useRealTimers();
        });

        it('stops waiting once the waits add up to more than a request waits', async () => {
          vi.useFakeTimers();
          process.stderr.write = (() => true) as any;
          // The fee keeps moving ahead of the wallet: each wait fits, together they don't.
          const start = Date.now();
          const balance = vi.fn().mockImplementation(() => Promise.reject(shortOf(HAS + 50n * PER_SECOND)));
          connector = createConnector({ bundleOverrides: { stateFn: growingFrom(start), balanceUnboundTransaction: balance } });

          const failure = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: any) => e);
          await vi.advanceTimersByTimeAsync(130_000);
          const err: any = await failure;
          expect(err.message).toContain("Not enough Dust available for this transaction's fee");
          expect(balance).toHaveBeenCalledTimes(3); // 51 s, 51 s, then a third 51 s would pass two minutes
          vi.useRealTimers();
        });
      });

      it('asks again at once when a coin comes free during the wait', async () => {
        vi.useFakeTimers();
        process.stderr.write = (() => true) as any;
        const attemptedAt: number[] = [];
        const started = Date.now();
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            // No Dust coin is free until one second in, when a pending transaction lands and releases its coin.
            stateFn: () => rx.concat(rx.of(mockState({ dustBalance: 0n })), rx.timer(1_000).pipe(rx.map(() => mockState({ dustBalance: 1000n })))),
            balanceUnboundTransaction: () => {
              attemptedAt.push(Date.now() - started);
              return attemptedAt.length < 2 ? Promise.reject(new Error('No dust tokens found in the wallet state')) : Promise.resolve({ type: 'UNBOUND' });
            },
          },
        });

        const promise = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
        await vi.advanceTimersByTimeAsync(1_100);
        await promise;
        expect(attemptedAt).toEqual([0, 1_000]);
        vi.useRealTimers();
      });

      // Found live: a coin that had just paid a fee was worth less than the
      // next one. It showed as available, so all ten attempts ran in 40 ms and
      // the request failed, though the coin would have covered it seconds later.
      it('gives a coin that is there but too small the delay to grow before each new attempt', async () => {
        vi.useFakeTimers();
        process.stderr.write = (() => true) as any;
        const shortage = Object.assign(new Error('Insufficient Funds: could not balance dust'), { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' });
        const attemptedAt: number[] = [];
        const started = Date.now();
        connector = createConnector({
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
          bundleOverrides: {
            // The wallet state shows Dust throughout; the fourth attempt finds it has grown enough.
            balanceUnboundTransaction: () => {
              attemptedAt.push(Date.now() - started);
              return attemptedAt.length < 4 ? Promise.reject(shortage) : Promise.resolve({ type: 'UNBOUND' });
            },
          },
        });

        const promise = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
        await vi.advanceTimersByTimeAsync(2_900);
        expect(attemptedAt).toEqual([0]);
        await vi.advanceTimersByTimeAsync(6_200);
        await promise;
        expect(attemptedAt).toEqual([0, 3_000, 6_000, 9_000]);
        vi.useRealTimers();
      });
    });

    // ── Hex-based pending tx tracking ──

    // ── What the wallet balances, per mode ──

    describe('token kinds to balance', () => {
      it.each([
        ['balanceUnsealedTransaction', 'balanceUnboundTransaction'],
        ['balanceSealedTransaction', 'balanceFinalizedTransaction'],
      ] as const)('%s balances every kind by default, and leaves the fee out when payFees is false', async (method, sdkMethod) => {
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
        connector = createConnector({ bundleOverrides: { [sdkMethod]: balance } });

        const tx = method === 'balanceUnsealedTransaction' ? AGENT_TX : SEALED_AGENT_TX;
        await connector.handlers[method]({ tx }, ctx());
        await connector.handlers[method]({ tx, options: { payFees: true } }, ctx());
        await connector.handlers[method]({ tx, options: { payFees: false } }, ctx());

        expect(balance.mock.calls.map((call) => call.at(-1))).toEqual([
          { ttl: expect.any(Date), tokenKindsToBalance: 'all' },
          { ttl: expect.any(Date), tokenKindsToBalance: 'all' },
          { ttl: expect.any(Date), tokenKindsToBalance: ['shielded', 'unshielded'] },
        ]);
      });
    });

    // ── Fee wallet: --approve-fees ──

    describe('fee wallet (approveFees)', () => {
      let origIsTTY: boolean | undefined;
      const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

      beforeEach(() => {
        origIsTTY = process.stdin.isTTY;
        // An agent has no terminal: anything that is not fee-only must be rejected, not prompted.
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        process.stderr.write = (() => true) as any;
      });

      afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      });

      /** A connector in fee-wallet mode over a bundle whose unshielded key is WALLET_VK. */
      function feeWallet(
        overrides?: BundleOverrides,
        approvalOptions: ApprovalOptions = { ...NO_TERMINAL, approveFees: true, autoApproveReads: true },
        feeLimits?: FeeLimits,
      ) {
        const bundle = createBundleStub(overrides);
        (bundle.keystore as any).getPublicKey = () => WALLET_VK;
        const feeConnector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions, feeLimits, notice: NO_TERMINAL.notice });
        connector = feeConnector;
        return { bundle, connector: feeConnector };
      }

      describe('fee limits', () => {
        const ONE_DUST = 1_000_000_000_000_000n;

        it('refuses a transaction whose estimated fee is over --max-fee, before balancing', async () => {
          const balance = vi.fn();
          const estimate = vi.fn().mockResolvedValue(ONE_DUST + 1n);
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, estimateTransactionFee: estimate }, undefined,
            { maxFeeSpecks: ONE_DUST, maxPending: 2 });

          const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx())
            .catch((e) => e);

          expect(err.code).toBe('Rejected');
          expect(err.message).toContain('over --max-fee 1.000000 DUST');
          expect(estimate).toHaveBeenCalledTimes(1);
          expect(balance).not.toHaveBeenCalled();
        });

        it('balances a transaction at the cap', async () => {
          const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, estimateTransactionFee: async () => ONE_DUST }, undefined,
            { maxFeeSpecks: ONE_DUST, maxPending: 2 });

          await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx());
          expect(balance).toHaveBeenCalledTimes(1);
        });

        it('refuses a new balance while --max-pending unsubmitted transactions hold Dust, and frees a slot on submit', async () => {
          const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
          const finalizeRecipe = vi.fn()
            .mockResolvedValueOnce(sealedTx(1))
            .mockResolvedValueOnce(sealedTx(2))
            .mockResolvedValueOnce(sealedTx(3));
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, finalizeRecipe }, undefined,
            { maxFeeSpecks: ONE_DUST, maxPending: 2 });
          const agentTx = { tx: hex(await unsealedBytes(agentPaysMerchant())) };

          const first: any = await connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c1'));
          await connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c2'));
          const err: any = await connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c1')).catch((e) => e);
          expect(err.code).toBe('Rejected');
          expect(err.message).toContain('2 balanced transactions are still waiting to be submitted (--max-pending 2)');
          expect(balance).toHaveBeenCalledTimes(2);

          await connector.handlers.submitTransaction({ tx: first.tx }, ctx('c1'));
          await connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c1'));
          expect(balance).toHaveBeenCalledTimes(3);
        });

        it('says a balanced transaction is holding the Dust when one is, and how many', async () => {
          vi.useFakeTimers();
          const stderrWrite = process.stderr.write;
          process.stderr.write = (() => true) as any;
          try {
            const balance = vi.fn()
              .mockResolvedValueOnce({ type: 'RECIPE' })
              // The shape of the wallet SDK's own Dust shortage.
              .mockRejectedValue(Object.assign(new Error('Insufficient Funds: could not balance dust'), { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' }));
            const { connector } = feeWallet({ balanceUnboundTransaction: balance, finalizeRecipe: vi.fn().mockResolvedValue(sealedTx(1)) }, undefined,
              { maxFeeSpecks: ONE_DUST, maxPending: 2 });
            const agentTx = { tx: hex(await unsealedBytes(agentPaysMerchant())) };

            await connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c1'));
            const failure = connector.handlers.balanceUnsealedTransaction(agentTx, ctx('c2')).catch((e: any) => e);
            await vi.advanceTimersByTimeAsync(9 * 2 * 3_000);
            const err: any = await failure;
            expect(err.message).toContain('No Dust is free to pay the fee ([Wallet.InsufficientFunds] Insufficient Funds: could not balance dust)');
            expect(err.message).toContain('1 balanced transaction(s) are waiting to be submitted on this server. Retry once they settle.');
            expect(classifyError(toEngineError(err) as Error, CORE_CODES).errorCode).toBe('DUST_REQUIRED');
            expect(err.mnCode).toBe('DUST_REQUIRED');
          } finally {
            process.stderr.write = stderrWrite;
            vi.useRealTimers();
          }
        });

        it('counts balances still in flight: two at the same moment cannot both take the last slot', async () => {
          let finishEstimate!: () => void;
          const estimateGate = new Promise<void>((r) => { finishEstimate = r; });
          const estimate = vi.fn(async () => { await estimateGate; return 1n; });
          const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, estimateTransactionFee: estimate }, undefined,
            { maxFeeSpecks: ONE_DUST, maxPending: 1 });
          const agentTx = { tx: hex(await unsealedBytes(agentPaysMerchant())) };

          const first = connector.handlers.balanceUnsealedTransaction(agentTx, ctx('a'));
          const second = connector.handlers.balanceUnsealedTransaction(agentTx, ctx('b')).catch((e: any) => e);
          finishEstimate();

          await expect(first).resolves.toHaveProperty('tx');
          const err: any = await second;
          expect(err.code).toBe('Rejected');
          expect(err.message).toContain('(--max-pending 1)');
          expect(balance).toHaveBeenCalledTimes(1);
        });

        it('gives the slot back when a balance fails, so the next one can use it', async () => {
          const estimate = vi.fn().mockResolvedValueOnce(2n * ONE_DUST).mockResolvedValue(1n);
          const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, estimateTransactionFee: estimate }, undefined,
            { maxFeeSpecks: ONE_DUST, maxPending: 1 });
          const agentTx = { tx: hex(await unsealedBytes(agentPaysMerchant())) };

          await expect(connector.handlers.balanceUnsealedTransaction(agentTx, ctx())).rejects.toMatchObject({ code: 'Rejected' });
          await expect(connector.handlers.balanceUnsealedTransaction(agentTx, ctx())).resolves.toHaveProperty('tx');
        });

        it('does not apply outside fee-wallet mode', async () => {
          const estimate = vi.fn().mockResolvedValue(10n * ONE_DUST);
          const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
          const { connector } = feeWallet({ balanceUnboundTransaction: balance, estimateTransactionFee: estimate },
            { ...NO_TERMINAL, approveAll: true }, { maxFeeSpecks: 1n, maxPending: 1 });

          await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx());
          expect(estimate).not.toHaveBeenCalled();
          expect(balance).toHaveBeenCalledTimes(1);
        });
      });

      it.each([
        ['balanceUnsealedTransaction', 'balanceUnboundTransaction', unsealedBytes],
        ['balanceSealedTransaction', 'balanceFinalizedTransaction', sealedBytes],
      ] as const)('%s balances Dust-only and is approved without a terminal', async (method, sdkMethod, toBytes) => {
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
        const { connector } = feeWallet({ [sdkMethod]: balance });

        const result = await connector.handlers[method]({ tx: hex(await toBytes(agentPaysMerchant())) }, ctx()) as any;

        expect(balance).toHaveBeenCalledTimes(1);
        expect(balance.mock.calls[0]!.at(-1)).toEqual({ ttl: expect.any(Date), tokenKindsToBalance: ['dust'] });
        expect(result).toEqual({ tx: FINALIZED_HEX });
      });

      it('approves a fee-only balance as fee-only, not as a prep step, so it holds with --no-auto-approve-reads', async () => {
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
        const { connector } = feeWallet({ balanceUnboundTransaction: balance }, { ...NO_TERMINAL, approveFees: true, autoApproveReads: false });

        const result = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx()) as any;

        expect(balance).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ tx: FINALIZED_HEX });
      });

      it('submits a transaction it balanced fee-only on the same connection, without a terminal', async () => {
        const submit = vi.fn().mockResolvedValue('tx-id');
        const { connector } = feeWallet({ submitTransaction: submit });

        const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx('agent')) as any;
        const result = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('agent'));

        expect(engine.handleHex(submit.mock.calls[0]![0])).toBe(FINALIZED_HEX);
        expect(result).toEqual({ txHash: 'tx-id' });
      });

      it('rejects submitting a transaction this server did not balance', async () => {
        const submit = vi.fn();
        const { connector } = feeWallet({ submitTransaction: submit });

        const err: any = await connector.handlers.submitTransaction({ tx: hex(await sealedBytes(agentPaysMerchant())) }, ctx('agent')).catch((e: any) => e);

        // Outside the fee policy, and no terminal to ask: nobody approves it.
        expect(err.code).toBe('PermissionRejected');
        expect(err.mnCode).toBe('APPROVAL_UNAVAILABLE');
        expect(submit).not.toHaveBeenCalled();
      });

      it('rejects submitting a fee-only transaction from another connection', async () => {
        const submit = vi.fn();
        const { connector } = feeWallet({ submitTransaction: submit });

        const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx('agent')) as any;
        const err: any = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('someone-else')).catch((e: any) => e);

        expect(err.code).toBe('PermissionRejected');
        expect(err.mnCode).toBe('APPROVAL_UNAVAILABLE');
        expect(submit).not.toHaveBeenCalled();
        // The refusal leaves the transaction the agent's: it still submits it, fee-only, unreverted.
        submit.mockResolvedValue('agent-hash');
        await expect(connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('agent'))).resolves.toEqual({ txHash: 'agent-hash' });
        expect(connector.hasPendingTxs()).toBe(false);
      });

      it('rejects submitting a transaction this server balanced, but not fee-only', async () => {
        const submit = vi.fn();
        const opts: ApprovalOptions = { ...NO_TERMINAL, approveAll: true };
        const { connector } = feeWallet({ submitTransaction: submit }, opts);

        const balanced = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('agent')) as any;
        delete opts.approveAll;
        opts.approveFees = true;
        const err: any = await connector.handlers.submitTransaction({ tx: balanced.tx }, ctx('agent')).catch((e: any) => e);

        // Nobody was asked, so nobody rejected it: the agent learns why, and that it is no operator's rejection.
        expect(err.code).toBe('PermissionRejected');
        expect(err.message).toBe('No one could be asked to approve the request: submitTransaction needs approval, and mn serve has no terminal to ask at. '
          + "This fee wallet (--approve-fees) approves without asking only paying the Dust fee for an agent's own transaction and submitting a transaction it balanced that way on the same connection.");
        expect(err.mnCode).toBe('APPROVAL_UNAVAILABLE');
        expect(submit).not.toHaveBeenCalled();
      });

      it.each([
        ['spends the wallet\'s own Night',
          () => buildTx({ guaranteed: { inputs: [spend(WALLET_SK, 100n)], outputs: [pay(100n)], signers: [WALLET_SK] } }),
          "intent 1 guaranteed unshielded input 0 spends this wallet's own funds"],
        ['leaves an input for the wallet to sign',
          () => buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [] } }),
          'intent 1 guaranteed unshielded input 0 is unsigned, so this wallet would sign it'],
        ['leaves an output for the wallet to fund',
          () => buildTx({ guaranteed: { inputs: [], outputs: [pay(100n)], signers: [] } }),
          `segment 0 is short 100 of unshielded token ${NIGHT}, which a Dust-only balance can't fund`],
      ])('refuses, with the reason, a transaction that %s, before balancing anything', async (_label, build, reason) => {
        const balance = vi.fn();
        const { bundle, connector } = feeWallet({ balanceUnboundTransaction: balance });

        const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: hex(await unsealedBytes(build())) }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('Rejected');
        expect(err.message).toContain('--approve-fees');
        expect(err.message).toContain(reason);
        expect(balance).not.toHaveBeenCalled();
        expect(bundle.facade.adoptTransaction).not.toHaveBeenCalled();
      });

      it('refuses payFees: false, which leaves a fee wallet nothing to do', async () => {
        const balance = vi.fn();
        const { connector } = feeWallet({ balanceUnboundTransaction: balance });

        const err: any = await connector.handlers.balanceUnsealedTransaction(
          { tx: hex(await unsealedBytes(agentPaysMerchant())), options: { payFees: false } }, ctx(),
        ).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain('payFees');
        expect(balance).not.toHaveBeenCalled();
      });

      it('refuses bytes it cannot read as a ledger-9 transaction of that stage', async () => {
        const balance = vi.fn();
        const { connector } = feeWallet({ balanceFinalizedTransaction: balance });

        const err: any = await connector.handlers.balanceSealedTransaction({ tx: hex(await unsealedBytes(agentPaysMerchant())) }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain('sealed');
        expect(balance).not.toHaveBeenCalled();
      });

      it('still needs a prompt for anything else, so an agent\'s makeTransfer is rejected', async () => {
        const transfer = vi.fn();
        const { connector } = feeWallet({ transferTransaction: transfer });

        const err: any = await connector.handlers.makeTransfer({
          desiredOutputs: [{ kind: 'unshielded', type: NIGHT, value: '1', recipient: UNSHIELDED_RECIPIENT }],
        }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('PermissionRejected');
        expect(err.mnCode).toBe('APPROVAL_UNAVAILABLE');
        expect(transfer).not.toHaveBeenCalled();
      });
    });

    describe('swap offers', () => {
      /** The real offer, as the SDK holds a finalized transaction. */
      const offerTx = () => engine.ledger.Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(SWAP_OFFER_HEX, 'hex'));
      const offerNullifier = () => (offerTx().guaranteedOffer!.inputs[0]!.nullifier as string);
      const openOffer = (): OpenOffer => ({
        id: 'f8'.repeat(32),
        terms: { give: { token: OFFER_GIVE, amount: 10n }, want: { token: '00'.repeat(31) + '02', amount: 7n } },
        nullifiers: [offerNullifier()],
        madeAt: new Date(0),
        expiresAt: new Date(0),
      });

      it('takes an offer: checks its signatures and proofs before building, balances every kind, checks the whole, and holds it pending', async () => {
        const validate = vi.fn().mockResolvedValue(undefined);
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE', blockData: 'block' });
        const bundle = createBundleStub({ validateTransaction: validate, balanceFinalizedTransaction: balance });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        expect(await connector.takeOffer('taker', SWAP_OFFER_HEX)).toBe(FINALIZED_HEX);

        expect(validate.mock.calls[0]![1]).toEqual({ flags: { enforceBalancing: false, verifySignatures: true, enforceLimits: false } });
        expect(engine.handleHex(validate.mock.calls[0]![0])).toBe(SWAP_OFFER_HEX);
        const [call] = balance.mock.calls;
        expect(engine.handleHex(call![0])).toBe(SWAP_OFFER_HEX);
        expect(call!.at(-1)).toMatchObject({ tokenKindsToBalance: 'all' });
        expect(validate.mock.calls[1]![1]).toEqual({ flags: { enforceBalancing: true, verifySignatures: true, enforceLimits: true }, blockData: 'block' });
        expect(connector.hasPendingTxs()).toBe(true);
      });

      it('refuses an offer whose signatures or proofs don\'t check, before building anything', async () => {
        const balance = vi.fn();
        const bundle = createBundleStub({ validateTransaction: vi.fn().mockRejectedValue(new Error('invalid proof')), balanceFinalizedTransaction: balance });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err = await connector.takeOffer('taker', SWAP_OFFER_HEX).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NotAnOfferError);
        expect((err as Error).message).toContain("its signatures or proofs don't check (invalid proof)");
        expect(balance).not.toHaveBeenCalled();
      });

      it('refuses a transaction that is no offer before validating anything', async () => {
        const validate = vi.fn();
        connector = engine.createDAppConnector({ bundle: createBundleStub({ validateTransaction: validate }), networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.takeOffer('taker', SEALED_AGENT_TX)).rejects.toBeInstanceOf(NotAnOfferError);
        expect(validate).not.toHaveBeenCalled();
      });

      it('refuses, and reverts, a transaction it built that would spend an open offer\'s coins', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const built = offerTx();
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(built) });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, openOffers: () => [openOffer()], notice: NO_TERMINAL.notice });

        const err = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(OfferCoinsInUseError);
        expect(revertFn).toHaveBeenCalledWith(built);
        expect(connector.hasPendingTxs()).toBe(false);
      });

      it("cancels an offer by sending the value of its coins back to itself, building with only those coins spendable", async () => {
        const offer = openOffer();
        const offerCoin = { type: OFFER_GIVE, value: 12n, nonce: offerNullifier() };
        const otherOffersCoin = { type: OFFER_GIVE, value: 5n, nonce: 'other-offer-coin' };
        const freeCoin = { type: OFFER_GIVE, value: 83n, nonce: 'free-coin' };
        const coinPicking = createCoinPicking<typeof offerCoin>(() => [offer, { ...offer, id: 'e7'.repeat(32), nullifiers: ['other-offer-coin'] }], (coin) => coin.nonce);
        const picked: (string | undefined)[] = [];
        const transfer = vi.fn().mockImplementation(async () => {
          // What the SDK's balancer would pick while the cancel is built: the offer's coin and none other.
          const coins = [freeCoin, otherOffersCoin, offerCoin];
          picked.push(coinPicking.pick(coins, OFFER_GIVE, 12n)?.nonce);
          picked.push(coinPicking.pick([freeCoin, otherOffersCoin], OFFER_GIVE, 1n)?.nonce);
          return { type: 'UNPROVEN_TRANSACTION' };
        });
        const bundle = createBundleStub({
          stateFn: () => rx.of(mockState({
            shieldedBalances: { [OFFER_GIVE]: 100n },
            shieldedCoins: [freeCoin, otherOffersCoin, offerCoin].map((coin) => ({ coin, nullifier: coin.nonce })),
          })),
          coinPicking,
          transferTransaction: transfer,
          finalizeRecipe: () => Promise.resolve(offerTx()),
        });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, openOffers: () => [offer], notice: NO_TERMINAL.notice });

        expect(await connector.cancelOffers('maker', [offer])).toBe(SWAP_OFFER_HEX);
        const [[outputs]] = transfer.mock.calls;
        expect(outputs).toHaveLength(1);
        expect(outputs[0].type).toBe('shielded');
        expect(outputs[0].outputs).toHaveLength(1);
        expect(outputs[0].outputs[0]).toMatchObject({ type: OFFER_GIVE, amount: 12n });
        expect(outputs[0].outputs[0].receiverAddress.coinPublicKeyString()).toBe(WALLET_SHIELDED.coinPublicKeyString());
        expect(picked).toEqual([offerNullifier(), undefined]);
        // After the cancel is built, spends skip the offers' coins again.
        expect(coinPicking.pick([freeCoin, otherOffersCoin, offerCoin], OFFER_GIVE, 12n)?.nonce).toBe('free-coin');
        expect(connector.hasPendingTxs()).toBe(true);
      });

      it("refuses a cancel when the wallet no longer holds the offer's coins, building nothing", async () => {
        const transfer = vi.fn();
        const bundle = createBundleStub({ stateFn: () => rx.of(mockState({ shieldedBalances: { [OFFER_GIVE]: 100n } })), transferTransaction: transfer });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.cancelOffers('maker', [openOffer()])).rejects.toMatchObject({ code: 'InvalidRequest' });
        expect(transfer).not.toHaveBeenCalled();
        expect(connector.hasPendingTxs()).toBe(false);
      });

      it("refuses a cancel that would not spend the offer's coins, keeping nothing", async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const offerCoin = { type: OFFER_GIVE, value: 12n, nonce: offerNullifier() };
        const bundle = createBundleStub({
          stateFn: () => rx.of(mockState({ shieldedBalances: { [OFFER_GIVE]: 12n }, shieldedCoins: [{ coin: offerCoin, nullifier: offerCoin.nonce }] })),
          finalizeRecipe: () => Promise.resolve(sealedTx(5)),
        });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.cancelOffers('maker', [openOffer()])).rejects.toMatchObject({ code: 'InvalidRequest' });
        expect(revertFn).toHaveBeenCalled();
        expect(connector.hasPendingTxs()).toBe(false);
      });

      it('says whether the wallet holds a free coin of exactly an amount: not one of its open offers\' coins', () => {
        const offer = openOffer();
        const coins = [
          { coin: { type: OFFER_GIVE, value: 10n, nonce: 'a' }, nullifier: offerNullifier() },
          { coin: { type: OFFER_GIVE, value: 7n, nonce: 'b' }, nullifier: 'free-7' },
        ];
        const bundle = createBundleStub({ stateFn: () => rx.of(mockState({ shieldedBalances: { [OFFER_GIVE]: 17n }, shieldedCoins: coins })) });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, openOffers: () => [offer], notice: NO_TERMINAL.notice });

        expect(connector.holdsFreeCoin(OFFER_GIVE, 7n)).toBe(true);
        expect(connector.holdsFreeCoin(OFFER_GIVE, 10n)).toBe(false);
        expect(connector.holdsFreeCoin(OFFER_GIVE, 3n)).toBe(false);
        expect(connector.holdsFreeCoin('00'.repeat(31) + '02', 7n)).toBe(false);
      });
    });

    describe('pending tx tracking (hex-based)', () => {
      it('untrackPendingTx works via hex key (not object identity)', async () => {
        // balanceUnsealedTransaction tracks a tx, then submitTransaction untracks by hex.
        // If untracking fails, revertPendingTxs would call revertTransaction.
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;

        const bundle = createBundleStub({
          finalizeRecipe: () => Promise.resolve(sealedTx(1)),
          submitTransaction: () => Promise.resolve('hash-123'),
        });
        (bundle.facade as any).revert = revertFn;

        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const connId = 'conn_hex_test';

        // Balance a tx — this tracks it
        const balanceResult = await connector.handlers.balanceUnsealedTransaction(
          { tx: AGENT_TX }, ctx(connId),
        ) as any;

        // Submit using the hex from balance result — this untracks by hex
        await connector.handlers.submitTransaction(
          { tx: balanceResult.tx }, ctx(connId),
        );

        // revertPendingTxs should have nothing to revert
        await connector.revertPendingTxs(connId);
        expect(revertFn).not.toHaveBeenCalled();
      });

      it('revertPendingTxs reverts tracked txs on disconnect', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;

        const finalized = sealedTx(2);
        const bundle = createBundleStub({
          finalizeRecipe: () => Promise.resolve(finalized),
        });
        (bundle.facade as any).revert = revertFn;

        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const connId = 'conn_revert_test';
        await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx(connId));

        // Disconnect reverts the FINALIZED transaction: that releases its coins in
        // all three wallets and clears its pending entry (the recipe would not).
        await connector.revertPendingTxs(connId);
        expect(revertFn).toHaveBeenCalledTimes(1);
        expect(revertFn).toHaveBeenCalledWith(finalized);
      });

      it('a transaction handed off is never reverted, on disconnect or by the abandon timer', async () => {
        vi.useFakeTimers();
        try {
          const revertFn = vi.fn().mockResolvedValue(undefined);
          process.stderr.write = (() => true) as any;
          const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(sealedTx(5)) });
          (bundle.facade as any).revert = revertFn;
          connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

          const built = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('conn_offer')) as { tx: string };
          expect(connector.handOffPendingTx('conn_offer', built.tx)).toBe(true);
          expect(connector.handOffPendingTx('conn_offer', built.tx)).toBe(false);
          expect(connector.hasPendingTxs()).toBe(false);

          await connector.revertPendingTxs('conn_offer');
          await vi.advanceTimersByTimeAsync(121_000);
          expect(revertFn).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      // Regression: closing the socket while its transaction was being
      // submitted freed that transaction's coins, so the next transaction
      // spent them too and the node refused it.
      it('does not revert a transaction whose submit is in flight when its connection closes, nor after it is submitted', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;
        let landed!: (hash: string) => void;
        const submitting = new Promise<string>((resolve) => { landed = resolve; });
        const submit = vi.fn(() => submitting);
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(sealedTx(4)), submitTransaction: submit });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const built = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('c1')) as { tx: string };
        const submitted = connector.handlers.submitTransaction({ tx: built.tx }, ctx('c1'));
        await vi.waitFor(() => expect(submit).toHaveBeenCalled());

        await connector.revertPendingTxs('c1');
        expect(revertFn).not.toHaveBeenCalled();
        // Its coins are still pending in the wallet: a shutdown must not save it as if none were.
        expect(connector.hasPendingTxs()).toBe(true);

        landed('hash-in-flight');
        await expect(submitted).resolves.toEqual({ txHash: 'hash-in-flight' });
        await connector.revertPendingTxs('c1');
        expect(revertFn).not.toHaveBeenCalled();
        expect(connector.hasPendingTxs()).toBe(false);
      });

      it('reverts a transaction whose submit fails after its connection closed', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;
        let refused!: (err: Error) => void;
        const submitting = new Promise<string>((_resolve, reject) => { refused = reject; });
        const finalized = sealedTx(4);
        const submit = vi.fn(() => submitting);
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(finalized), submitTransaction: submit });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const built = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('c1')) as { tx: string };
        const submitted = connector.handlers.submitTransaction({ tx: built.tx }, ctx('c1')).catch((e: Error) => e);
        await vi.waitFor(() => expect(submit).toHaveBeenCalled());
        await connector.revertPendingTxs('c1');

        refused(new Error('1010: Invalid Transaction: Custom error: 115'));
        expect(await submitted).toBeInstanceOf(Error);
        expect(revertFn).toHaveBeenCalledTimes(1);
        expect(revertFn).toHaveBeenCalledWith(finalized);
        expect(connector.hasPendingTxs()).toBe(false);
      });

      // Regression: a transaction built on one connection and submitted on
      // another was reverted when the first one closed.
      it('lets another connection take a transaction over: submitted there, it is not reverted when the connection that built it closes', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(sealedTx(6)), submitTransaction: () => Promise.resolve('hash-b') });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const built = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('a')) as { tx: string };
        await connector.handlers.submitTransaction({ tx: built.tx }, ctx('b'));

        await connector.revertPendingTxs('a');
        expect(revertFn).not.toHaveBeenCalled();
        expect(connector.hasPendingTxs()).toBe(false);
      });

      // Regression: a makeTransfer whose coins another request's transaction
      // held until it landed was refused with the SDK's bare "Insufficient funds".
      it('says coins are held by the server\'s other pending transactions when the SDK finds too few free ones', async () => {
        process.stderr.write = (() => true) as any;
        const shortage = () => Object.assign(new Error('Insufficient funds'), { _tag: 'Wallet.InsufficientFunds' });
        const transfer = vi.fn().mockRejectedValue(shortage());
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(sealedTx(9)), transferTransaction: transfer });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
        const desired = { desiredOutputs: [{ kind: 'unshielded', type: '00'.repeat(32), value: '1', recipient: UNSHIELDED_RECIPIENT }] };

        // None pending: the shortage is the wallet's, said as the SDK said it.
        const alone: any = await connector.handlers.makeTransfer(desired, ctx('c2')).catch((e: any) => e);
        expect(alone.message).toBe('Insufficient funds');

        await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('c1'));
        const err: any = await connector.handlers.makeTransfer(desired, ctx('c2')).catch((e: any) => e);
        expect(err.code).toBe('InsufficientFunds');
        expect(err.mnCode).toBe('INSUFFICIENT_BALANCE');
        expect(err.message).toBe("The wallet's free coins don't cover this: 1 other transaction of this wallet's, made here, holds coins until it is on chain or released (being built, built and not yet submitted, or being submitted). Retry once it has landed or been released; if it still fails, the wallet holds too little.");
      });

      it('counts another request\'s transaction still being built as holding coins', async () => {
        process.stderr.write = (() => true) as any;
        let built!: (recipe: unknown) => void;
        const transfer = vi.fn()
          .mockImplementationOnce(() => new Promise((resolve) => { built = resolve; }))
          .mockRejectedValueOnce(Object.assign(new Error('Insufficient funds'), { _tag: 'Wallet.InsufficientFunds' }));
        const bundle = createBundleStub({ finalizeRecipe: () => Promise.resolve(sealedTx(9)), transferTransaction: transfer });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
        const desired = { desiredOutputs: [{ kind: 'unshielded', type: '00'.repeat(32), value: '1', recipient: UNSHIELDED_RECIPIENT }] };

        const first = connector.handlers.makeTransfer(desired, ctx('c1'));
        await vi.waitFor(() => expect(transfer).toHaveBeenCalledTimes(1));
        const err: any = await connector.handlers.makeTransfer(desired, ctx('c2')).catch((e: any) => e);
        expect(err.code).toBe('InsufficientFunds');
        expect(err.message).toContain("1 other transaction of this wallet's, made here, holds coins");

        built({ type: 'RECIPE' });
        await expect(first).resolves.toEqual({ tx: expect.any(String) });
      });

      it('submitTransaction rejection reverts and untracks', async () => {
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const origIsTTY = process.stdin.isTTY;
        process.stderr.write = (() => true) as any;

        const finalized = sealedTx(3);
        const bundle = createBundleStub({
          finalizeRecipe: () => Promise.resolve(finalized),
        });
        (bundle.facade as any).revert = revertFn;

        // Use a single connector — approvalOptions is a mutable object reference.
        // Balance with approveAll, then remove it so submit rejects via non-TTY.
        const opts: Record<string, any> = { ...NO_TERMINAL, approveAll: true };
        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: opts,
        });

        const connId = 'conn_reject_test';

        // Balance first (auto-approved via approveAll) — tracks the tx internally
        const balanceResult = await connector.handlers.balanceUnsealedTransaction(
          { tx: AGENT_TX }, ctx(connId),
        ) as any;

        // Switch: remove approveAll + non-TTY → submit will be rejected
        delete opts.approveAll;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

        // Submit on the SAME connector → rejection → reverts the finalized tx
        await expect(connector.handlers.submitTransaction({ tx: balanceResult.tx }, ctx(connId)))
          .rejects.toMatchObject({ code: 'PermissionRejected', mnCode: 'APPROVAL_UNAVAILABLE' });

        expect(revertFn).toHaveBeenCalledWith(finalized);
        // Untracked: a later disconnect has nothing left to revert.
        revertFn.mockClear();
        await connector.revertPendingTxs(connId);
        expect(revertFn).not.toHaveBeenCalled();

        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      });
    });

    describe('a dApp transaction the wallet SDK cannot sign correctly', () => {
      // wallet-sdk 2.0.0-rc.0 duplicates the signatures already on an offer it
      // signs, so one with both signed and unsigned inputs can't be signed.
      const partlySigned = async () => Buffer.from(await unsealedBytes(buildTx({
        guaranteed: { inputs: [spend(AGENT_SK, 60n, 0)], outputs: [pay(60n)], signers: [AGENT_SK] },
        fallible: { inputs: [spend(WALLET_SK, 40n, 1)], outputs: [pay(40n)], signers: [] },
      }))).toString('hex');

      it('is refused as InvalidRequest before the operator is asked and before anything is balanced', async () => {
        const balance = vi.fn();
        const bundle = createBundleStub({ balanceUnboundTransaction: balance });
        // No approveAll and no TTY: reaching the approval step would fail as Rejected instead.
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL }, notice: NO_TERMINAL.notice });
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
          const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: await partlySigned() }, ctx()).catch((e: any) => e);

          expect(err.code).toBe('InvalidRequest');
          expect(err.message).toContain('both signed and unsigned unshielded inputs');
          expect(balance).not.toHaveBeenCalled();
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      });

      // Signed by the agent, 40 Night over: unshielded balancing would merge an
      // output for it into the agent's intent, invalidating the agent's signature.
      const signedWithSurplus = async () => Buffer.from(await unsealedBytes(buildTx({
        guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(60n)], signers: [AGENT_SK] },
      }))).toString('hex');

      it.each([
        ['every token kind (the default)', undefined],
        ['all but Dust (payFees: false)', { payFees: false }],
      ])('a signed transaction that needs unshielded balancing is refused as InvalidRequest when balancing %s', async (_mode, options) => {
        const balance = vi.fn();
        connector = createConnector({ bundleOverrides: { balanceUnboundTransaction: balance } });

        const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: await signedWithSurplus(), options }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain('segment 0 is not balanced in unshielded value');
        expect(balance).not.toHaveBeenCalled();
      });

      it('the same transaction goes on to a Dust-only balance on a fee wallet, which adds nothing to its intent', async () => {
        const balance = vi.fn().mockResolvedValue({ type: 'RECIPE' });
        const bundle = createBundleStub({ balanceUnboundTransaction: balance });
        (bundle.keystore as any).getPublicKey = () => WALLET_VK;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveFees: true, autoApproveReads: true }, notice: NO_TERMINAL.notice });

        await connector.handlers.balanceUnsealedTransaction({ tx: await signedWithSurplus() }, ctx());

        expect(balance.mock.calls[0]!.at(-1)).toMatchObject({ tokenKindsToBalance: ['dust'] });
      });

      it('a partly signed transaction found only at signing is still InvalidRequest, with its recipe reverted', async () => {
        const recipe = { type: 'RECIPE' };
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const bundle = createBundleStub({
          balanceUnboundTransaction: () => Promise.resolve(recipe),
          signRecipe: () => Promise.reject(new engine.PartlySignedTransactionError()),
        });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        const err: any = await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toContain('both signed and unsigned unshielded inputs');
        expect(revertFn).toHaveBeenCalledWith(recipe);
      });
    });

    describe('balancing on a server started without --approve-all or --approve-fees', () => {
      // Found live: a dApp asked plain `mn serve` (no terminal) to balance a spend
      // of the wallet's own NIGHT and got back a sealed transaction carrying the
      // wallet's valid signature, which it could submit through any node.
      it.each([
        ['balanceUnsealedTransaction', unsealedBytes, 'balanceUnboundTransaction'],
        ['balanceSealedTransaction', sealedBytes, 'balanceFinalizedTransaction'],
      ] as const)('%s prompts, so with no terminal a spend of the wallet\'s own NIGHT is rejected before anything is balanced or signed', async (method, toBytes, balanceMethod) => {
        const walletSpend = Buffer.from(await toBytes(buildTx({
          guaranteed: { inputs: [spend(WALLET_SK, 990n)], outputs: [pay(990n)], signers: [] },
        }))).toString('hex');
        const balance = vi.fn();
        const bundle = createBundleStub({ [balanceMethod]: balance });
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, autoApproveReads: true }, notice: NO_TERMINAL.notice });
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
          const err: any = await connector.handlers[method]({ tx: walletSpend }, ctx()).catch((e: any) => e);

          expect(err.code).toBe('PermissionRejected');
          expect(err.mnCode).toBe('APPROVAL_UNAVAILABLE');
          expect(balance).not.toHaveBeenCalled();
          expect(bundle.facade.signRecipe).not.toHaveBeenCalled();
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      });
    });

    describe('an expired dApp transaction', () => {
      it.each([
        ['balanceUnsealedTransaction', unsealedBytes, 'balanceUnboundTransaction'],
        ['balanceSealedTransaction', sealedBytes, 'balanceFinalizedTransaction'],
      ] as const)('%s refuses it as InvalidRequest, naming the intent and its TTL, before balancing', async (method, toBytes, sdkMethod) => {
        // A whole second: the ledger keeps an intent's TTL to the second.
        const ttl = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
        const agentPaidAMinuteTooLate = buildTx({ guaranteed: { inputs: [spend(AGENT_SK, 100n)], outputs: [pay(100n)], signers: [AGENT_SK] } }, ttl);
        const expired = Buffer.from(await toBytes(agentPaidAMinuteTooLate)).toString('hex');
        const balance = vi.fn();
        connector = createConnector({ bundleOverrides: { [sdkMethod]: balance } });

        const err: any = await (connector.handlers as any)[method]({ tx: expired }, ctx()).catch((e: any) => e);

        expect(err.code).toBe('InvalidRequest');
        expect(err.message).toBe(`The transaction has expired: intent 1's TTL (${ttl.toISOString()}) has passed. Build it again with a later TTL.`);
        expect(balance).not.toHaveBeenCalled();
      });
    });

    describe('failed signing', () => {
      it('reverts the recipe so its coins are not held until the TTL', async () => {
        const recipe = { type: 'RECIPE' };
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const bundle = createBundleStub({
          balanceUnboundTransaction: () => Promise.resolve(recipe),
          signRecipe: () => Promise.reject(new Error('signer unavailable')),
        });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).rejects.toThrow('signer unavailable');
        expect(revertFn).toHaveBeenCalledWith(recipe);
        expect(bundle.facade.finalizeRecipe).not.toHaveBeenCalled();
      });
    });

    describe('failed proving', () => {
      it('reverts the recipe so its coins are not held until the TTL', async () => {
        const recipe = { type: 'RECIPE' };
        const revertFn = vi.fn().mockResolvedValue(undefined);
        const bundle = createBundleStub({
          balanceUnboundTransaction: () => Promise.resolve(recipe),
          finalizeRecipe: () => Promise.reject(new Error('proof server unreachable')),
        });
        (bundle.facade as any).revert = revertFn;
        connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

        await expect(connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx())).rejects.toThrow('proof server unreachable');
        expect(revertFn).toHaveBeenCalledWith(recipe);
      });

      it('also reverts a proof that finishes after the timeout, so no stale pending tx is left', async () => {
        vi.useFakeTimers();
        try {
          const recipe = { type: 'RECIPE' };
          const late = sealedTx(9);
          let finishProof!: (tx: unknown) => void;
          const revertFn = vi.fn().mockResolvedValue(undefined);
          const bundle = createBundleStub({
            balanceUnboundTransaction: () => Promise.resolve(recipe),
            finalizeRecipe: () => new Promise((resolve) => { finishProof = resolve; }),
          });
          (bundle.facade as any).revert = revertFn;
          connector = engine.createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });

          const call = connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx());
          // A ProofTimeoutError, which mn reports as PROOF_TIMEOUT and the wire carries as its mn code.
          const outcome = expect(call).rejects.toMatchObject({ message: 'ZK proof generation timed out', code: 'PROOF_TIMEOUT' });
          await vi.advanceTimersByTimeAsync(PROOF_TIMEOUT_MS + 1);
          await outcome;
          expect(revertFn).toHaveBeenCalledWith(recipe);

          // The SDK registers the finalized tx as pending when the proof lands.
          finishProof(late);
          await vi.advanceTimersByTimeAsync(0);
          expect(revertFn).toHaveBeenCalledWith(late);
        } finally {
          vi.useRealTimers();
        }
      });
    });

    // ── Abandon timer ──

    describe('abandon timer', () => {
      it('auto-reverts after timeout', async () => {
        vi.useFakeTimers();
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;

        const bundle = createBundleStub({
          finalizeRecipe: () => Promise.resolve(sealedTx(4)),
        });
        (bundle.facade as any).revert = revertFn;

        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        const connId = 'conn_abandon';
        await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx(connId));

        // Advance past ABANDONED_TX_TIMEOUT_MS (120_000ms)
        await vi.advanceTimersByTimeAsync(121_000);

        // Timer fires and reverts the abandoned tx
        expect(revertFn).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
      });

      it('dispose clears abandon timers', async () => {
        vi.useFakeTimers();
        const revertFn = vi.fn().mockResolvedValue(undefined);
        process.stderr.write = (() => true) as any;

        const bundle = createBundleStub({
          finalizeRecipe: () => Promise.resolve(sealedTx(5)),
        });
        (bundle.facade as any).revert = revertFn;

        connector = engine.createDAppConnector({
          notice: NO_TERMINAL.notice,
          bundle,
          networkConfig: TEST_NETWORK_CONFIG,
          approvalOptions: { ...NO_TERMINAL, approveAll: true },
        });

        await connector.handlers.balanceUnsealedTransaction({ tx: AGENT_TX }, ctx('conn_dispose'));

        // Dispose before timeout fires
        connector.dispose();
        connector = undefined;

        await vi.advanceTimersByTimeAsync(121_000);
        expect(revertFn).not.toHaveBeenCalled();

        vi.useRealTimers();
      });
    });
  });
}
