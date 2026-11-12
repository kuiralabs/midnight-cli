// The wallet SDK's facade, stubbed at the SDK boundary, and the DApp connector
// over it: shared by the connector's tests and the wallet session's. Built
// over an engine's own pieces (`connectorStub`), so it loads no engine itself:
// a test file loads one engine at most.

import { vi } from 'vitest';
import * as rx from 'rxjs';
import type { NetworkConfig, RpcHandlerContext } from '@kuiralabs/midnight-cli-core';
import { type ApprovalOptions, type CoinPicking, createCoinPicking, newFeePricing } from '@kuiralabs/midnight-cli-core/engine';

/** A connector test's host: nobody at a terminal to ask, and the connector's lines dropped. */
export const NO_TERMINAL = { prompter: null, notice: (_line: string): void => {} } as const;

/** A DApp connector, as the engine makes one. */
export interface StubConnector {
  handlers: Record<string, (params: any, ctx: RpcHandlerContext) => Promise<unknown>>;
  dispose(): void;
  revertPendingTxs(connectionId: string): Promise<void>;
  handOffPendingTx(connectionId: string, txHex: string): boolean;
  takeOffer(connectionId: string, txHex: string): Promise<string>;
  cancelOffers(connectionId: string, offers: readonly unknown[]): Promise<string>;
  holdsFreeCoin(token: string, amount: bigint): boolean;
  hasPendingTxs(): boolean;
}

/** What the stub takes from an engine. */
export interface StubEngine {
  createDAppConnector(options: any): StubConnector;
  deriveShieldedAddress(seed: Buffer): any;
  DustAddress: new (data: bigint) => any;
  UnshieldedAddress: new (data: Buffer) => any;
  /** The protocol version each wallet reports once on ledger 9. */
  ledger9ProtocolVersion: bigint;
  /** What finalizeRecipe gives back unless a test says otherwise. */
  finalized?: () => unknown;
}

/** A finalized transaction handle as the SDK returns it: it serializes to these bytes. */
export const finalizedTx = (...bytes: number[]) => ({ serialize: () => new Uint8Array(bytes) });

export const TEST_NETWORK_CONFIG: NetworkConfig = {
  indexer: 'http://localhost:8088/api/v4/graphql',
  indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
  node: 'ws://localhost:9944',
  proofServer: 'http://localhost:6300',
  networkId: 'Undeployed',
};

/** Wallet history as the SDK records it: one finalized, one rejected, one pending. */
export const HISTORY = [
  { hash: 'tx-hash-001', identifiers: [], status: 'SUCCESS', lifecycle: { status: 'finalized', finalizedBlock: { hash: 'b1', height: 1, timestamp: new Date(0) } } },
  { hash: 'tx-hash-002', identifiers: [], lifecycle: { status: 'rejected', rejectedAt: new Date(0) } },
  { hash: 'tx-hash-003', identifiers: [], lifecycle: { status: 'pending', submittedAt: new Date(0) } },
];

/**
 * The wallet's history as a connector reads it: empty when the connector is
 * made (its first read, which is what it saw before serving), `entries` at
 * every read after.
 */
export function historyAfterServing(entries: readonly unknown[], before: readonly unknown[] = []) {
  return vi.fn().mockResolvedValueOnce([...before]).mockResolvedValue([...entries]);
}

export interface BundleOverrides {
  stateFn?: () => rx.Observable<any>;
  /** How the wallet picks coins; mn's own over no open offers when not given. */
  coinPicking?: CoinPicking<{ type: string; value: bigint; nonce: string }>;
  transferTransaction?: (...args: any[]) => Promise<any>;
  signRecipe?: (...args: any[]) => Promise<any>;
  finalizeRecipe?: (...args: any[]) => Promise<any>;
  submitTransaction?: (...args: any[]) => Promise<string>;
  balanceUnboundTransaction?: (...args: any[]) => Promise<any>;
  balanceFinalizedTransaction?: (...args: any[]) => Promise<any>;
  initSwap?: (...args: any[]) => Promise<any>;
  getAllFromTxHistory?: () => Promise<any[]>;
  estimateTransactionFee?: (...args: any[]) => Promise<bigint>;
  calculateTransactionFee?: (...args: any[]) => Promise<bigint>;
  validateTransaction?: (...args: any[]) => Promise<void>;
}

/** The facade stub and connector over `engine`'s pieces. */
export function connectorStub(engine: StubEngine) {
  /** The wallet's own addresses, as SDK address objects in its state. */
  const WALLET_SHIELDED = engine.deriveShieldedAddress(Buffer.from('00'.repeat(31) + '07', 'hex'));
  const WALLET_UNSHIELDED = new engine.UnshieldedAddress(Buffer.alloc(32, 7));
  const WALLET_DUST = new engine.DustAddress(7n);

  /** Create a minimal mock FacadeState. */
  function mockState(overrides?: {
    unshieldedBalances?: Record<string, bigint>;
    shieldedBalances?: Record<string, bigint>;
    /** The shielded coins the wallet holds unspent, each with its nullifier, as the SDK's state lists them. */
    shieldedCoins?: { coin: { type: string; value: bigint; nonce: string }; nullifier: string }[];
    dustBalance?: bigint;
    /** The wallet's Dust coins, as the SDK's state lists them: each one's cap, and when its NIGHT was spent. */
    dustCoins?: { maxCap: bigint; dtime: Date | undefined }[];
    /** The Dust coins a transaction not yet on chain pays with, by nonce, as the SDK's state lists them. */
    pendingDustNonces?: bigint[];
    protocolVersion?: { shielded: bigint; unshielded: bigint; dust: bigint };
    isSynced?: boolean;
  }) {
    const v9 = engine.ledger9ProtocolVersion;
    return {
      isSynced: overrides?.isSynced ?? true,
      // Each wallet's protocol version, as the rc SDK's FacadeState reports it: on ledger 9 unless a test says otherwise.
      protocolVersion: overrides?.protocolVersion ?? { shielded: v9, unshielded: v9, dust: v9 },
      unshielded: {
        balances: overrides?.unshieldedBalances ?? { '0000000000000000000000000000000000000000000000000000000000000000': 5000000n },
        address: WALLET_UNSHIELDED,
        progress: { appliedId: 1n, highestTransactionId: 1n },
      },
      shielded: {
        balances: overrides?.shieldedBalances ?? {},
        availableCoins: overrides?.shieldedCoins ?? [],
        address: WALLET_SHIELDED,
      },
      dust: {
        balance: (_time: Date) => overrides?.dustBalance ?? 1000n,
        availableCoins: [],
        pendingCoins: (overrides?.pendingDustNonces ?? []).map((nonce) => ({ token: { nonce } })),
        totalCoins: overrides?.dustCoins ?? [],
        address: WALLET_DUST,
      },
    };
  }

  /** Create a minimal FacadeBundle stub. */
  function createBundleStub(overrides?: BundleOverrides): any {
    const defaultStateFn = () => rx.of(mockState());
    const finalized = engine.finalized ?? (() => finalizedTx(0xab, 0xcd));

    return {
      facade: {
        state: overrides?.stateFn ?? defaultStateFn,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        transferTransaction: overrides?.transferTransaction ?? vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
        signRecipe: overrides?.signRecipe ?? vi.fn().mockResolvedValue({ type: 'SIGNED' }),
        finalizeRecipe: overrides?.finalizeRecipe ?? vi.fn().mockImplementation(async () => finalized()),
        submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash'),
        balanceUnboundTransaction: overrides?.balanceUnboundTransaction ?? vi.fn().mockResolvedValue({ type: 'UNBOUND' }),
        balanceFinalizedTransaction: overrides?.balanceFinalizedTransaction ?? vi.fn().mockResolvedValue({ type: 'FINALIZED' }),
        initSwap: overrides?.initSwap ?? vi.fn().mockResolvedValue({ type: 'SWAP' }),
        registerNightUtxosForDustGeneration: vi.fn(),
        // The rc SDK's reader.
        adoptTransaction: vi.fn((bytes: Uint8Array, stage: string) => ({ stage, hex: Buffer.from(bytes).toString('hex') })),
        estimateTransactionFee: overrides?.estimateTransactionFee ?? vi.fn().mockResolvedValue(1_000n),
        calculateTransactionFee: overrides?.calculateTransactionFee ?? vi.fn().mockResolvedValue(1_000n),
        // The wallet's history: empty when the connector is made (its first read), HISTORY after.
        getAllFromTxHistory: overrides?.getAllFromTxHistory ?? historyAfterServing(HISTORY),
        validateTransaction: overrides?.validateTransaction ?? vi.fn().mockResolvedValue(undefined),
      },
      keystore: {
        signDataAsync: vi.fn().mockResolvedValue({ tag: 'schnorr', value: 'abcd1234signature' }),
        getPublicKey: vi.fn().mockReturnValue({ tag: 'schnorr', value: '5678efghpubkey' }),
      },
      // mn's own coin picking, over no open offers; a coin's nullifier here is its nonce.
      coinPicking: overrides?.coinPicking ?? createCoinPicking<{ type: string; value: bigint; nonce: string }>(() => [], (coin) => coin.nonce),
      // mn's own fee settings, as buildFacade gives each wallet.
      feePricing: newFeePricing(),
    };
  }

  function createConnector(overrides?: {
    bundleOverrides?: BundleOverrides;
    networkConfig?: NetworkConfig;
    approvalOptions?: ApprovalOptions;
    /** Where the connector's lines go; dropped when not given. */
    notice?: (line: string) => void;
    /** Where the lines of its waits for Dust go; `notice` when not given. */
    waiting?: (line: string, opening: boolean) => void;
  }): StubConnector {
    return engine.createDAppConnector({
      bundle: createBundleStub(overrides?.bundleOverrides),
      networkConfig: overrides?.networkConfig ?? TEST_NETWORK_CONFIG,
      approvalOptions: overrides?.approvalOptions ?? { ...NO_TERMINAL, approveAll: true },
      notice: overrides?.notice ?? NO_TERMINAL.notice,
      ...(overrides?.waiting === undefined ? {} : { waiting: overrides.waiting }),
    });
  }

  return { WALLET_SHIELDED, WALLET_UNSHIELDED, WALLET_DUST, mockState, createBundleStub, createConnector };
}
