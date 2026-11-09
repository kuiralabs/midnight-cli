// The NIGHT mn's local flows airdrop to the wallets they create: enough that
// the wallet's first transactions don't wait for Dust. The Dust a wallet holds
// is the ledger's: registered NIGHT generates INITIAL_GENERATION_DECAY_RATE
// specks per STAR a second from the airdrop's block (measured on a ledger-9
// local chain: 100,000 NIGHT gained 0.8267 DUST a second). The fees are the
// ones measured on that chain on 2026-11-09.

import { describe, expect, it } from 'vitest';
import { INITIAL_GENERATION_DECAY_RATE, LOCAL_WALLET_FUNDING_NIGHT, TOKEN_MULTIPLIER } from '../lib/constants.ts';
import { SPECKS_PER_DUST } from '../lib/fee-limits.ts';
import { msUntilDust } from '../lib/dust-wait.ts';

const AIRDROP = new Date('2026-11-09T02:28:06Z');
const dust = (amount: number) => BigInt(Math.round(amount * 1000)) * SPECKS_PER_DUST / 1000n;
const REGISTRATION_FEE = dust(0.289);
const TRANSFER_FEE = dust(0.548);
const DEPLOY_FEE = dust(1.08);
/** How long after the airdrop mn test's registration pays its fee: the airdrop's own 22 s, then the registration's sync. */
const REGISTERED_AFTER_S = 25;

/** The Dust of a wallet airdropped `night` at AIRDROP, less `spent` specks. */
function walletDust(night: number, spent: bigint) {
  const perSecond = BigInt(night * TOKEN_MULTIPLIER) * INITIAL_GENERATION_DECAY_RATE;
  return { balance: (at: Date) => perSecond * BigInt(Math.max(0, Math.floor((at.getTime() - AIRDROP.getTime()) / 1000))) - spent };
}
const secondsAfterAirdrop = (s: number) => new Date(AIRDROP.getTime() + s * 1000);
const DAY_MS = 86_400_000;

describe('LOCAL_WALLET_FUNDING_NIGHT', () => {
  it('generates 0.41 DUST a second, the ledger rate times the amount', () => {
    const perSecond = walletDust(LOCAL_WALLET_FUNDING_NIGHT, 0n).balance(secondsAfterAirdrop(1));
    expect(perSecond).toBe(413_350_000_000_000n);
  });

  it('pays the registration without waiting', () => {
    expect(msUntilDust(walletDust(LOCAL_WALLET_FUNDING_NIGHT, 0n), REGISTRATION_FEE, secondsAfterAirdrop(REGISTERED_AFTER_S), DAY_MS)).toBe(0);
  });

  it('pays a deploy right after registering, and generates the next deploy fee in 3 s', () => {
    const now = secondsAfterAirdrop(REGISTERED_AFTER_S);
    expect(msUntilDust(walletDust(LOCAL_WALLET_FUNDING_NIGHT, REGISTRATION_FEE), DEPLOY_FEE, now, DAY_MS)).toBe(0);
    // Spent down to nothing: the fee comes back in whole seconds.
    const emptied = walletDust(LOCAL_WALLET_FUNDING_NIGHT, walletDust(LOCAL_WALLET_FUNDING_NIGHT, 0n).balance(now));
    expect(msUntilDust(emptied, DEPLOY_FEE, now, DAY_MS)).toBe(3_000);
    expect(msUntilDust(emptied, TRANSFER_FEE, now, DAY_MS)).toBe(2_000);
  });

  it('covers a registration, a deploy and twenty transfers in the first minute', () => {
    const spent = REGISTRATION_FEE + DEPLOY_FEE + 20n * TRANSFER_FEE;
    expect(msUntilDust(walletDust(LOCAL_WALLET_FUNDING_NIGHT, 0n), spent, secondsAfterAirdrop(60), DAY_MS)).toBe(0);
  });

  it('is what the 1000 NIGHT before it was not: there a deploy waited minutes after the registration', () => {
    const now = secondsAfterAirdrop(REGISTERED_AFTER_S);
    const wait = msUntilDust(walletDust(1000, REGISTRATION_FEE), DEPLOY_FEE, now, DAY_MS);
    expect(wait).toBeGreaterThan(2 * 60_000);
  });
});
