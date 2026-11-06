// The beta engine, the one stagenet runs, in a process of its own: its set,
// its compiler, keys that match the rc engine's, and its connector, whose
// facade (stubbed at the SDK boundary) takes the wallet's secret keys on every
// call that spends, and refuses transaction work before the wallet's first state.

import { describe, it, expect, vi } from 'vitest';
import * as rx from 'rxjs';
import { createBetaEngine } from '../index.ts';
import { createHost, type NetworkConfig, type RpcHandlerContext } from '@kuiralabs/midnight-cli-core';
import { createDAppConnector } from '../dapp-connector.ts';
import type { FacadeBundle } from '../facade.ts';
import { deriveShieldedAddress } from '../derive-address.ts';
import { NO_TERMINAL } from '../../../../test-support/connector-stub.ts';

// A beta engine, for what every host's has alike: its keys, ledger and contracts.
const betaEngine = createBetaEngine(createHost());

// The beta set's own address classes, as the engine resolves them: the
// repository's root holds the rc set's.
const { DustAddress, UnshieldedAddress } = await import(new URL('../../node_modules/@midnightntwrk/wallet-sdk-address-format/dist/index.js', import.meta.url).href) as typeof import('@midnightntwrk/wallet-sdk-address-format');

const STAGENET: NetworkConfig = {
  indexer: 'http://localhost:8088/api/v4/graphql',
  indexerWS: 'ws://localhost:8088/api/v4/graphql/ws',
  node: 'ws://localhost:9944',
  proofServer: 'http://localhost:6300',
  networkId: 'StageNet',
};

const NIGHT = '0000000000000000000000000000000000000000000000000000000000000000';
const ctx = (): RpcHandlerContext => ({ notify: vi.fn(), connectionId: 'conn_beta', requestId: 1, metadata: {} });

/** A facade state with NIGHT and Dust, as the beta SDK reports it (no protocol versions). */
function stateWithFunds() {
  return {
    isSynced: true,
    unshielded: { balances: { [NIGHT]: 5_000_000n }, address: new UnshieldedAddress(Buffer.alloc(32, 7)), progress: { appliedId: 1n, highestTransactionId: 1n } },
    shielded: { balances: {}, address: deriveShieldedAddress(Buffer.from('00'.repeat(31) + '07', 'hex')) },
    dust: { balance: () => 1_000_000_000_000_000n, availableCoins: [], address: new DustAddress(7n) },
  };
}

const SECRET_KEYS = { shieldedSecretKeys: { tag: 'zswap' }, dustSecretKey: { tag: 'dust' } };

function bundleWith(states: rx.Observable<unknown>, facade: Record<string, unknown> = {}): FacadeBundle {
  return {
    facade: {
      state: () => states,
      transferTransaction: vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      initSwap: vi.fn().mockResolvedValue({ type: 'UNPROVEN_TRANSACTION' }),
      signRecipe: vi.fn().mockResolvedValue({ type: 'SIGNED' }),
      finalizeRecipe: vi.fn().mockResolvedValue({ serialize: () => new Uint8Array([0xab, 0xcd]) }),
      ...facade,
    },
    keystore: { signDataAsync: vi.fn(), getPublicKey: vi.fn() },
    secretKeys: SECRET_KEYS,
  } as unknown as FacadeBundle;
}

const RECIPIENT = 'mn_addr_stagenet1ugtvumxjrspvh598y6agtw3sdk06qf8sl0x0pfu6lf2080wrnprsqxvrpj';

describe('the beta engine', () => {
  it('runs the beta set, on contracts compactc 0.33 writes', () => {
    expect(betaEngine.set).toBe('beta');
    expect(betaEngine.contracts.scripts.compiler).toBe('compactc 0.33');
    expect(betaEngine.contracts.scripts.compactRuntimeVersion).toBe('0.18.0-rc.1');
    expect(betaEngine.contracts.scripts.acceptsRuntime('0.18.0')).toBe(true);
    expect(betaEngine.contracts.scripts.acceptsRuntime('0.20.0')).toBe(false);
  });

  it('derives the addresses the rc engine derives, on every network', () => {
    // The rc engine's address for this seed on stagenet, as a new wallet's file records it.
    const seed = Buffer.alloc(32, 2);
    expect(betaEngine.keys.unshieldedAddress(seed, 'stagenet')).toBe(RECIPIENT);
    expect(betaEngine.keys.unshieldedAddresses(seed).undeployed).toBe('mn_addr_undeployed1ugtvumxjrspvh598y6agtw3sdk06qf8sl0x0pfu6lf2080wrnprsdj8xxx');
    // Mainnet's prefix has no network segment.
    expect(betaEngine.keys.unshieldedAddresses(seed).mainnet).toBe('mn_addr1ugtvumxjrspvh598y6agtw3sdk06qf8sl0x0pfu6lf2080wrnprsvaf25q');
  });
});

describe('the beta engine\'s connector', () => {
  it('refuses transaction work before the wallet\'s first state, as the rc engine does', async () => {
    const connector = createDAppConnector({ bundle: bundleWith(rx.NEVER), networkConfig: STAGENET, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
    try {
      await expect(connector.handlers.makeTransfer({ desiredOutputs: [{ kind: 'unshielded', type: NIGHT, value: '1', recipient: RECIPIENT }] }, ctx()))
        .rejects.toMatchObject({ code: 'Disconnected', reason: 'Wallet not synced yet' });
      await expect(connector.handlers.getUnshieldedBalances({}, ctx())).rejects.toMatchObject({ code: 'Disconnected' });
    } finally {
      connector.dispose();
    }
  });

  it('hands the facade the wallet\'s secret keys to build a transfer and a swap', async () => {
    const bundle = bundleWith(rx.of(stateWithFunds()));
    const connector = createDAppConnector({ bundle, networkConfig: STAGENET, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
    try {
      const output = { kind: 'unshielded', type: NIGHT, value: '1', recipient: RECIPIENT };
      await expect(connector.handlers.makeTransfer({ desiredOutputs: [output] }, ctx())).resolves.toEqual({ tx: 'abcd' });
      expect((bundle.facade.transferTransaction as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(SECRET_KEYS);
      await expect(connector.handlers.makeIntent({ desiredInputs: [{ kind: 'unshielded', type: NIGHT, value: '1' }], desiredOutputs: [output], options: {} }, ctx())).resolves.toEqual({ tx: 'abcd' });
      expect((bundle.facade.initSwap as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toBe(SECRET_KEYS);
    } finally {
      connector.dispose();
    }
  });

  it('refuses a transaction it can\'t read as ledger 9 as the caller\'s mistake', async () => {
    const connector = createDAppConnector({ bundle: bundleWith(rx.of(stateWithFunds())), networkConfig: STAGENET, approvalOptions: { ...NO_TERMINAL, approveAll: true }, notice: NO_TERMINAL.notice });
    try {
      await expect(connector.handlers.balanceUnsealedTransaction({ tx: 'beef' }, ctx())).rejects.toMatchObject({ code: 'InvalidRequest' });
    } finally {
      connector.dispose();
    }
  });
});
