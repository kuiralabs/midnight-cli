// The offers a wallet has made and not seen taken or cancelled, in mn's state,
// and the check that keeps a later spend from silently cancelling one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeOpenOffers, OfferCoinsInUseError, openOffersFile, readOpenOffers, recordOpenOffer, type OpenOffer } from '../lib/open-offers.ts';
import { classifyError, ERROR_CODES, EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';
import { assertSpendsNoOfferCoin } from '../lib/open-offers.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

const WALLET = 'mn_addr_undeployed1maker';
const offer = (id: string, nullifiers: string[]): OpenOffer => ({
  id,
  terms: { give: { token: '00'.repeat(31) + '01', amount: 10n }, want: { token: '00'.repeat(31) + '02', amount: 7n } },
  nullifiers,
  madeAt: new Date('2026-11-02T10:00:00.000Z'),
  expiresAt: new Date('2026-11-03T10:00:00.000Z'),
});

let home: string;
let root: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mn-open-offers-'));
  root = join(home, '.midnight');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('open offers', () => {
  it('records an offer per wallet and network, in mn\'s state, readable only by its owner', () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    expect(readOpenOffers(root, 'undeployed', WALLET)).toEqual([offer('a1', ['n1'])]);
    expect(readOpenOffers(root, 'stagenet', WALLET)).toEqual([]);
    expect(openOffersFile(root, 'undeployed', WALLET)).toBe(join(root, 'swap-offers', 'undeployed', `${WALLET}.json`));
    expect(statSync(openOffersFile(root, 'undeployed', WALLET)).mode & 0o077).toBe(0);
  });

  it('closes offers by id, keeping the rest', () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    recordOpenOffer(root, 'undeployed', WALLET, offer('a2', ['n2']));
    expect(closeOpenOffers(root, 'undeployed', WALLET, ['a1']).map((o) => o.id)).toEqual(['a1']);
    expect(readOpenOffers(root, 'undeployed', WALLET).map((o) => o.id)).toEqual(['a2']);
    expect(closeOpenOffers(root, 'undeployed', WALLET, ['gone'])).toEqual([]);
  });

  it('refuses a spend of an open offer\'s coin, naming the offer, unless the spend cancels it', () => {
    const open = [offer('a1'.repeat(16), ['AA11']), offer('b2'.repeat(16), ['bb22'])];
    expect(() => assertSpendsNoOfferCoin(open, ['cc33'])).not.toThrow();
    const err = (() => { try { assertSpendsNoOfferCoin(open, ['aa11', 'cc33']); } catch (e) { return e; } })() as OfferCoinsInUseError;
    expect(err).toBeInstanceOf(OfferCoinsInUseError);
    expect(err.offerIds).toEqual(['a1'.repeat(16)]);
    expect(err.message).toBe(`This would spend coins held by an open swap offer (${'a1'.repeat(8)}…), cancelling it. Cancel it first, or wait until it is taken.`);
    expect(classifyError(err, CORE_CODES)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.OFFER_COINS_IN_USE });
    expect(() => assertSpendsNoOfferCoin(open, ['aa11'], ['a1'.repeat(16)])).not.toThrow();
  });
});
