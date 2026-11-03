// What a `swap` command asks for, read from its arguments before any wallet
// opens: the terms, the expiry, and an offer file checked against its bytes,
// its network, the agreed terms and its expiry.

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { encodeOfferEnvelope, OfferExpiredError } from '@kuiralabs/midnight-cli-core/lib/offer-envelope';
import { NotAnOfferError, TermsMismatchError } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { readOffer } from '@kuiralabs/midnight-engine-rc/offer-reader';
import { DEFAULT_OFFER_LIFETIME_S, prepareMake, prepareTake, termsOf } from '../lib/swap/request.ts';
import { OFFER_GIVE, OFFER_WANT, SWAP_OFFER_HEX } from './fixtures/swap-offer.ts';

const NOW = new Date('2026-11-02T12:00:00.000Z');
// A state root with no config: the networks' own endpoints.
const ROOT = mkdtempSync(join(tmpdir(), 'mn-swap-request-root-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const TERMS = ['--give', '10', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_WANT];

describe('the terms', () => {
  it('reads what the maker gives and wants, tokens lower-cased', () => {
    expect(termsOf(parseArgs(['swap', 'make', '--give', '10', '--give-token', OFFER_GIVE.toUpperCase(), '--want', '7', '--want-token', OFFER_WANT]))).toEqual({
      give: { token: OFFER_GIVE, amount: 10n }, want: { token: OFFER_WANT, amount: 7n },
    });
  });

  it.each([
    [['--give', '10', '--give-token', OFFER_GIVE], '--want and --want-token are required'],
    [['--give', '0', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_WANT], '--give must be a whole amount'],
    [['--give', '1.5', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_WANT], '--give must be a whole amount'],
    [['--give', '10', '--give-token', 'night', '--want', '7', '--want-token', OFFER_WANT], '--give-token must be a token type'],
    [['--give', '10', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_GIVE], 'one token for another'],
  ])('refuses %j as a usage error', (flags, reason) => {
    expect(() => termsOf(parseArgs(['swap', 'make', ...flags]))).toThrow(UsageError);
    expect(() => termsOf(parseArgs(['swap', 'make', ...flags]))).toThrow(reason);
  });
});

describe('make', () => {
  it('expires a day on unless --expires-in says', () => {
    expect(prepareMake(parseArgs(['swap', 'make', ...TERMS, '--network', 'undeployed']), ROOT, NOW).expiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_OFFER_LIFETIME_S * 1000));
    expect(prepareMake(parseArgs(['swap', 'make', ...TERMS, '--network', 'undeployed', '--expires-in', '60']), ROOT, NOW).expiresAt).toEqual(new Date(NOW.getTime() + 60_000));
    expect(() => prepareMake(parseArgs(['swap', 'make', ...TERMS, '--network', 'undeployed', '--expires-in', 'soon']), ROOT, NOW)).toThrow('--expires-in must be a whole number of seconds');
  });
});

describe('take', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-swap-take-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const offerFile = (overrides: { network?: string; expiresAt?: Date; tx?: string } = {}) => {
    const read = readOffer(SWAP_OFFER_HEX);
    const file = join(dir, 'offer.json');
    writeFileSync(file, encodeOfferEnvelope({
      network: (overrides.network ?? 'undeployed') as 'undeployed', id: read.id, terms: read.terms,
      expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60_000), tx: overrides.tx ?? SWAP_OFFER_HEX,
    }));
    return file;
  };
  const take = (file: string, terms = TERMS) => prepareTake(parseArgs(['swap', 'take', file, ...terms, '--network', 'undeployed']), ROOT, NOW);

  it('reads a real offer file at the agreed terms', async () => {
    const { offer, agreed, target } = await take(offerFile());
    expect(target.network).toBe('undeployed');
    expect(offer.contents.terms).toEqual(agreed);
  });

  it('refuses other terms, an expired offer, an offer for another network, and a file whose bytes say otherwise', async () => {
    await expect(take(offerFile(), ['--give', '11', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_WANT])).rejects.toBeInstanceOf(TermsMismatchError);
    await expect(take(offerFile({ expiresAt: NOW }))).rejects.toBeInstanceOf(OfferExpiredError);
    await expect(take(offerFile({ network: 'preview' }))).rejects.toThrow('The offer is for preview, not undeployed');
    await expect(take(offerFile({ tx: SWAP_OFFER_HEX.slice(0, -2) + '00' }))).rejects.toBeInstanceOf(NotAnOfferError);
    await expect(take(join(dir, 'missing.json'))).rejects.toThrow("Can't read the offer file");
  });
});
