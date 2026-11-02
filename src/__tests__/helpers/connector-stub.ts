// The wallet SDK's facade, stubbed at the SDK boundary, and the DApp connector
// over it: shared by the connector's tests and the wallet session's.

import { vi } from 'vitest';
import * as rx from 'rxjs';
import { createDAppConnector, type DAppConnector } from '@kuiralabs/midnight-engine-rc/dapp-connector';
import type { FacadeBundle } from '@kuiralabs/midnight-engine-rc/facade';
import { FORK_SCHEDULE } from '@kuiralabs/midnight-engine-rc/fork-schedule';
import { deriveShieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { DustAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import type { ApprovalOptions } from '@kuiralabs/midnight-cli-core/lib/approval';

/** The wallet's own addresses, as SDK address objects in its state. */
export const WALLET_SHIELDED = deriveShieldedAddress(Buffer.from('00'.repeat(31) + '07', 'hex'));
export const WALLET_UNSHIELDED = new UnshieldedAddress(Buffer.alloc(32, 7));
export const WALLET_DUST = new DustAddress(7n);

/** A finalized transaction handle as the SDK returns it: it serializes to these bytes. */
export const finalizedTx = (...bytes: number[]) => ({ serialize: () => new Uint8Array(bytes) });



export const TEST_NETWORK_CONFIG: NetworkConfig = {
  indexer: 'http://localhost:8088/api/v4/graphql',
  indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
  node: 'ws://localhost:9944',
  proofServer: 'http://localhost:6300',
  networkId: 'Undeployed',
};

/** Create a minimal mock FacadeState. */
export function mockState(overrides?: {
  unshieldedBalances?: Record<string, bigint>;
  shieldedBalances?: Record<string, bigint>;
  dustBalance?: bigint;
  protocolVersion?: { shielded: bigint; unshielded: bigint; dust: bigint };
  isSynced?: boolean;
}) {
  return {
    isSynced: overrides?.isSynced ?? true,
    // Each wallet's protocol version, as FacadeState reports it: on ledger 9 unless a test says otherwise.
    protocolVersion: overrides?.protocolVersion ?? { shielded: FORK_SCHEDULE.v9, unshielded: FORK_SCHEDULE.v9, dust: FORK_SCHEDULE.v9 },
    unshielded: {
      balances: overrides?.unshieldedBalances ?? { '0000000000000000000000000000000000000000000000000000000000000000': 5000000n },
      address: WALLET_UNSHIELDED,
      progress: { appliedId: 1n, highestTransactionId: 1n },
    },
    shielded: {
      balances: overrides?.shieldedBalances ?? {},
      address: WALLET_SHIELDED,
    },
    dust: {
      balance: (_time: Date) => overrides?.dustBalance ?? 1000n,
      availableCoins: [],
      address: WALLET_DUST,
    },
  };
}

/** Wallet history as the SDK records it: one finalized, one rejected, one pending. */
export const HISTORY = [
  { hash: 'tx-hash-001', identifiers: [], status: 'SUCCESS', lifecycle: { status: 'finalized', finalizedBlock: { hash: 'b1', height: 1, timestamp: new Date(0) } } },
  { hash: 'tx-hash-002', identifiers: [], lifecycle: { status: 'rejected', rejectedAt: new Date(0) } },
  { hash: 'tx-hash-003', identifiers: [], lifecycle: { status: 'pending', submittedAt: new Date(0) } },
];

/** Create a minimal FacadeBundle stub. */
export function createBundleStub(overrides?: {
  stateFn?: () => rx.Observable<any>;
  transferTransaction?: () => Promise<any>;
  signRecipe?: () => Promise<any>;
  finalizeRecipe?: () => Promise<any>;
  submitTransaction?: () => Promise<string>;
  balanceUnboundTransaction?: () => Promise<any>;
  balanceFinalizedTransaction?: () => Promise<any>;
  initSwap?: () => Promise<any>;
  getAllFromTxHistory?: () => Promise<any[]>;
  estimateTransactionFee?: (...args: any[]) => Promise<bigint>;
}): FacadeBundle {
  const defaultStateFn = () => rx.of(mockState());

  return {
    facade: {
      state: overrides?.stateFn ?? defaultStateFn,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      transferTransaction: overrides?.transferTransaction ?? vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      signRecipe: overrides?.signRecipe ?? vi.fn().mockResolvedValue({ type: 'SIGNED' }),
      finalizeRecipe: overrides?.finalizeRecipe ?? vi.fn().mockResolvedValue(finalizedTx(0xab, 0xcd)),
      submitTransaction: overrides?.submitTransaction ?? vi.fn().mockResolvedValue('mock-tx-hash'),
      balanceUnboundTransaction: overrides?.balanceUnboundTransaction ?? vi.fn().mockResolvedValue({ type: 'UNBOUND' }),
      balanceFinalizedTransaction: overrides?.balanceFinalizedTransaction ?? vi.fn().mockResolvedValue({ type: 'FINALIZED' }),
      initSwap: overrides?.initSwap ?? vi.fn().mockResolvedValue({ type: 'SWAP' }),
      registerNightUtxosForDustGeneration: vi.fn(),
      adoptTransaction: vi.fn((bytes: Uint8Array, stage: string) => ({ stage, hex: Buffer.from(bytes).toString('hex') })),
      estimateTransactionFee: overrides?.estimateTransactionFee ?? vi.fn().mockResolvedValue(1_000n),
      getAllFromTxHistory: overrides?.getAllFromTxHistory ?? vi.fn().mockResolvedValue(HISTORY),
    },
    keystore: {
      signDataAsync: vi.fn().mockResolvedValue({ tag: 'schnorr', value: 'abcd1234signature' }),
      getPublicKey: vi.fn().mockReturnValue({ tag: 'schnorr', value: '5678efghpubkey' }),
    },
  } as unknown as FacadeBundle;
}

export function createConnector(overrides?: {
  bundleOverrides?: Parameters<typeof createBundleStub>[0];
  networkConfig?: NetworkConfig;
  approvalOptions?: ApprovalOptions;
}): DAppConnector {
  return createDAppConnector({
    bundle: createBundleStub(overrides?.bundleOverrides),
    networkConfig: overrides?.networkConfig ?? TEST_NETWORK_CONFIG,
    approvalOptions: overrides?.approvalOptions ?? { approveAll: true },
  });
}
