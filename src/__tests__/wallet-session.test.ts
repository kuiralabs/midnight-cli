// The wallet session over the rc engine's DApp connector, its facade stubbed
// at the SDK boundary: each operation answers in the session's own types, and
// closing reverts what was built but never submitted.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as rx from 'rxjs';
import { DustAddress, MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { sessionOver, type WalletSession } from '@kuiralabs/midnight-cli-core/lib/wallet-session';
import type { TransactionDetail } from '@kuiralabs/midnight-cli-core/lib/engine';
import { deriveShieldedAddress, deriveUnshieldedAddress } from '@kuiralabs/midnight-engine-rc/derive-address';
import { TEST_NETWORK_CONFIG, connectorStub } from './helpers/connector-stub.ts';
import { createDAppConnector } from '@kuiralabs/midnight-engine-rc/dapp-connector';
import { FORK_SCHEDULE } from '@kuiralabs/midnight-engine-rc/fork-schedule';
import { agentPaysMerchant, unsealedBytes } from './helpers/ledger-tx.ts';

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
      const connector = createDAppConnector({ bundle, networkConfig: TEST_NETWORK_CONFIG, approvalOptions: { approveAll: true } });
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

    it('gives up after five attempts with the SDK\'s refusal', async () => {
      const reopen = vi.fn(async () => openedWith(() => Promise.reject(coldStart())));
      const session = sessionOver('undeployed', openedWith(() => Promise.reject(coldStart())), () => [], { reopen, delayMs: 0 });

      await expect(session.swap(give, take)).rejects.toMatchObject({ _tag: 'Wallet.InsufficientFunds' });
      expect(reopen).toHaveBeenCalledTimes(4);
      await session.close();
    });

    it('does not reopen once it has built a transaction, which reopening would revert under the caller', async () => {
      const initSwap = vi.fn().mockResolvedValueOnce({ type: 'SWAP' }).mockRejectedValue(coldStart());
      const reopen = vi.fn();
      const session = sessionOver('undeployed', openedWith(initSwap), () => [], { reopen, delayMs: 0 });

      await session.swap(give, take);
      await expect(session.swap(give, take)).rejects.toMatchObject({ _tag: 'Wallet.InsufficientFunds' });
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
});
