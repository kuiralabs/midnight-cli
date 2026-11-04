// The offer file: written and read back, refused when it isn't one or says
// other than its transaction, and refused once past the maker's expiry.

import { describe, it, expect } from 'vitest';
import { assertEnvelopeMatches, assertOfferUnexpired, decodeOfferEnvelope, encodeOfferEnvelope, OfferExpiredError, type OfferEnvelope } from '../lib/offer-envelope.ts';
import { classifyError, ERROR_CODES, EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';
import { NotAnOfferError } from '../lib/swap-offer.ts';
import { CORE_CODES } from '../../../../test-support/core-codes.ts';

const A = '00'.repeat(31) + '01';
const B = '00'.repeat(31) + '02';
const ENVELOPE: OfferEnvelope = {
  network: 'undeployed',
  id: 'ab'.repeat(32),
  terms: { give: { token: A, amount: 10n }, want: { token: B, amount: 12345678901234567890n } },
  expiresAt: new Date('2026-11-03T12:00:00.000Z'),
  tx: 'beef',
};

describe('the offer file', () => {
  it('reads back what was written, amounts of any size included', () => {
    const text = encodeOfferEnvelope(ENVELOPE);
    expect(JSON.parse(text)).toMatchObject({ kind: 'midnight-swap-offer', version: 1, terms: { want: { amount: '12345678901234567890' } } });
    expect(decodeOfferEnvelope(text)).toEqual(ENVELOPE);
  });

  it.each([
    ['text that is not JSON', 'zswapoffer1qq…', 'not JSON'],
    ['JSON of another kind', JSON.stringify({ kind: 'contract' }), 'not an offer file'],
    ['a version this mn does not read', JSON.stringify({ ...JSON.parse(encodeOfferEnvelope(ENVELOPE)), version: 2 }), 'version 2'],
    ['a leg with no amount', JSON.stringify({ ...JSON.parse(encodeOfferEnvelope(ENVELOPE)), terms: { give: { token: A }, want: { token: B, amount: '1' } } }), "give is not a token and a whole amount"],
    ['an expiry that is not a date', JSON.stringify({ ...JSON.parse(encodeOfferEnvelope(ENVELOPE)), expiresAt: 'soon' }), 'not a date'],
  ])('refuses %s as no offer', (_case, text, reason) => {
    expect(() => decodeOfferEnvelope(text)).toThrow(NotAnOfferError);
    expect(() => decodeOfferEnvelope(text)).toThrow(reason);
  });

  it('refuses a file whose id or terms are not its transaction\'s', () => {
    const read = { id: ENVELOPE.id, terms: ENVELOPE.terms, nullifiers: [] };
    expect(() => assertEnvelopeMatches(ENVELOPE, read)).not.toThrow();
    expect(() => assertEnvelopeMatches(ENVELOPE, { ...read, id: 'cd'.repeat(32) })).toThrow("the offer file's id is not its transaction's");
    expect(() => assertEnvelopeMatches(ENVELOPE, { ...read, terms: { ...read.terms, give: { token: A, amount: 11n } } })).toThrow('states other terms than its transaction holds');
  });

  it('refuses an offer from its expiry on, as the caller\'s to fix', () => {
    expect(() => assertOfferUnexpired(ENVELOPE, new Date('2026-11-03T11:59:59.999Z'))).not.toThrow();
    const err = (() => { try { assertOfferUnexpired(ENVELOPE, ENVELOPE.expiresAt); } catch (e) { return e; } })() as OfferExpiredError;
    expect(err).toBeInstanceOf(OfferExpiredError);
    expect(err.message).toBe(`The offer ${'ab'.repeat(8)}… expired at 2026-11-03T12:00:00.000Z; ask the maker for a new one`);
    expect(classifyError(err, CORE_CODES)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.OFFER_EXPIRED });
  });
});
