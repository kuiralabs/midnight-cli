// The wallet session over the rc engine's DApp connector, its facade stubbed
// at the SDK boundary: each operation answers in the session's own types, and
// closing reverts what was built but never submitted.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as rx from 'rxjs';
import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { sessionOver, type WalletSession } from '@kuiralabs/midnight-cli-core/lib/wallet-session';
import type { TransactionDetail } from '@kuiralabs/midnight-cli-core/lib/engine';
import { deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { TEST_NETWORK_CONFIG, WALLET_SHIELDED, WALLET_UNSHIELDED, createBundleStub, mockState } from './helpers/connector-stub.ts';
import { createDAppConnector } from '@kuiralabs/midnight-engine-rc/dapp-connector';
import { agentPaysMerchant, unsealedBytes } from './helpers/ledger-tx.ts';

const NIGHT_RAW = '0000000000000000000000000000000000000000000000000000000000000000';
const OTHER_TOKEN = '02' + '00'.repeat(31);
const RECIPIENT = deriveUnshieldedAddress(Buffer.from('00'.repeat(31) + '42', 'hex'), 'undeployed');

/** A real unsealed ledger-9 dApp transaction, as hex. */
let AGENT_TX: string;
beforeAll(async () => {
  AGENT_TX = Buffer.from(await unsealedBytes(agentPaysMerchant())).toString('hex');
});

function openSession(options: { bundleOverrides?: Parameters<typeof createBundleStub>[0]; readTransaction?: (tx: string, stage: 'unsealed' | 'sealed') => TransactionDetail[] } = {}) {
  const bundle = createBundleStub({
    stateFn: () => rx.of(mockState({ unshieldedBalances: { [NIGHT_RAW]: 7_000_000n }, shieldedBalances: { [NIGHT_RAW]: 3n }, dustBalance: 42n })),
    ...options.bundleOverrides,
  });
  const revert = vi.fn().mockResolvedValue(undefined);
  (bundle.facade as unknown as { revert: typeof revert }).revert = revert;
  const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });
  const stop = vi.fn(async () => { connector.dispose(); });
  const session: WalletSession = sessionOver('undeployed', { connector, stop }, options.readTransaction ?? (() => []));
  return { session, bundle, revert, stop };
}

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
});
