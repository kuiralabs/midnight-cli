// The offers a wallet has made and not seen taken or cancelled, in mn's state,
// and the check that keeps a later spend from silently cancelling one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeOpenOffers, OfferCoinsInUseError, OfferRecordUnreadableError, openOffersFile, readOpenOffers, readSettledOffers, recordOpenOffer, SETTLED_OFFER_KEEP_DAYS, type OpenOffer } from '../lib/open-offers.ts';
import { readFileSync } from 'node:fs';
import { classifyError, ERROR_CODES, EXIT_GENERAL_ERROR, EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';
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
    expect(readOpenOffers(root, 'preview', WALLET)).toEqual([]);
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

// Regression: a record mn could not read failed as UNKNOWN with the raw JSON
// parse error, naming no file.
describe('an open-offers record mn cannot read', () => {
  const written = (text: string): string => {
    const file = openOffersFile(root, 'undeployed', WALLET);
    mkdirSync(join(root, 'swap-offers', 'undeployed'), { recursive: true });
    writeFileSync(file, text);
    return file;
  };

  it.each([
    ['cut short', '{"offers": [ {"id": '],
    ['not an object', '[]'],
    ['offers not a list', '{"offers": 3}'],
    ['an offer without its terms', '{"offers": [{"id": "a1", "nullifiers": [], "madeAt": "2026-11-02T10:00:00.000Z", "expiresAt": "2026-11-03T10:00:00.000Z"}]}'],
    ['an amount that is not a number', '{"offers": [{"id": "a1", "terms": {"give": {"token": "01", "amount": "ten"}, "want": {"token": "02", "amount": "7"}}, "nullifiers": [], "madeAt": "2026-11-02T10:00:00.000Z", "expiresAt": "2026-11-03T10:00:00.000Z"}]}'],
    ['a date that is not one', '{"offers": [{"id": "a1", "terms": {"give": {"token": "01", "amount": "10"}, "want": {"token": "02", "amount": "7"}}, "nullifiers": [], "madeAt": "yesterday", "expiresAt": "2026-11-03T10:00:00.000Z"}]}'],
  ])('%s: refused with its own code, naming the file and what to do', (_case, text) => {
    const file = written(text);
    const refused = (() => { try { readOpenOffers(root, 'undeployed', WALLET); } catch (e) { return e; } })();
    expect(refused).toBeInstanceOf(OfferRecordUnreadableError);
    expect((refused as OfferRecordUnreadableError).file).toBe(file);
    expect((refused as Error).message).toContain(file);
    expect((refused as Error).message).toMatch(/move it aside/);
    expect(classifyError(refused as Error, CORE_CODES)).toEqual({ exitCode: EXIT_GENERAL_ERROR, errorCode: 'OFFER_RECORD_UNREADABLE' });
  });

  it('reads an empty list as no offers', () => {
    written('{"offers": []}');
    expect(readOpenOffers(root, 'undeployed', WALLET)).toEqual([]);
  });
});

// Regression: `swap list` dropped a taken offer from the record once it had
// shown it, so a later `swap cancel` answered "no open offer" (INVALID_ARGS)
// instead of OFFER_TAKEN with the transaction that took it.
describe('settled offers', () => {
  const SETTLED_AT = new Date('2026-11-04T10:00:00.000Z');

  it('are kept apart from the open ones, with how they settled and in which transaction', () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    recordOpenOffer(root, 'undeployed', WALLET, offer('a2', ['n2']));
    closeOpenOffers(root, 'undeployed', WALLET, ['a1'], { settledBy: 'taken', txHash: '00' + 'ab'.repeat(32), hash: 'cd'.repeat(32), blockHeight: 800, at: SETTLED_AT });
    expect(readOpenOffers(root, 'undeployed', WALLET).map((o) => o.id)).toEqual(['a2']);
    expect(readSettledOffers(root, 'undeployed', WALLET, SETTLED_AT)).toEqual([{ ...offer('a1', ['n1']), settledBy: 'taken', settledAt: SETTLED_AT, txHash: '00' + 'ab'.repeat(32), hash: 'cd'.repeat(32), blockHeight: 800 }]);
    // A new offer recorded later keeps them.
    recordOpenOffer(root, 'undeployed', WALLET, offer('a3', ['n3']));
    expect(readSettledOffers(root, 'undeployed', WALLET, SETTLED_AT).map((o) => o.id)).toEqual(['a1']);
  });

  // An mn before 0.6.0's release kept the taking transaction's hash as a taken offer's txHash, where txHash is the identifier.
  it('read a taken one an earlier mn kept with the hash as its txHash as the hash; a cancel\'s txHash stays the identifier', () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    recordOpenOffer(root, 'undeployed', WALLET, offer('a2', ['n2']));
    const stored = JSON.parse(readFileSync(openOffersFile(root, 'undeployed', WALLET), 'utf-8'));
    const [a1, a2] = stored.offers;
    writeFileSync(openOffersFile(root, 'undeployed', WALLET), JSON.stringify({ offers: [], settled: [
      { ...a1, settledBy: 'taken', settledAt: SETTLED_AT.toISOString(), txHash: 'cd'.repeat(32), blockHeight: 800 },
      { ...a2, settledBy: 'cancelled', settledAt: SETTLED_AT.toISOString(), txHash: '00' + 'ef'.repeat(32) },
    ] }));
    expect(readSettledOffers(root, 'undeployed', WALLET, SETTLED_AT).map((o) => [o.id, o.txHash, o.hash])).toEqual([['a1', undefined, 'cd'.repeat(32)], ['a2', '00' + 'ef'.repeat(32), undefined]]);
  });

  it('stay out of the list of offers an older mn reads, so it never takes one for open', () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    closeOpenOffers(root, 'undeployed', WALLET, ['a1'], { settledBy: 'cancelled', txHash: 'ef'.repeat(32), at: SETTLED_AT });
    const stored = JSON.parse(readFileSync(openOffersFile(root, 'undeployed', WALLET), 'utf-8'));
    expect(stored.offers).toEqual([]);
    expect(stored.settled).toHaveLength(1);
  });

  it('read a record an older mn wrote, with none settled, as it was', () => {
    mkdirSync(join(root, 'swap-offers', 'undeployed'), { recursive: true });
    writeFileSync(openOffersFile(root, 'undeployed', WALLET), JSON.stringify({ offers: [] }));
    expect(readSettledOffers(root, 'undeployed', WALLET)).toEqual([]);
  });

  it(`are forgotten ${SETTLED_OFFER_KEEP_DAYS} days after they settled`, () => {
    recordOpenOffer(root, 'undeployed', WALLET, offer('a1', ['n1']));
    closeOpenOffers(root, 'undeployed', WALLET, ['a1'], { settledBy: 'taken', txHash: 'cd'.repeat(32), blockHeight: 800, at: SETTLED_AT });
    const day = 24 * 60 * 60 * 1000;
    expect(readSettledOffers(root, 'undeployed', WALLET, new Date(SETTLED_AT.getTime() + (SETTLED_OFFER_KEEP_DAYS - 1) * day))).toHaveLength(1);
    expect(readSettledOffers(root, 'undeployed', WALLET, new Date(SETTLED_AT.getTime() + (SETTLED_OFFER_KEEP_DAYS + 1) * day))).toEqual([]);
  });
});

