// The offer reader's tests, over either SDK engine: a real offer (made on a
// local ledger-9 chain, never submitted) is read from its bytes alone, and
// what is not an offer is refused. Each engine reads with its own ledger.
// This file loads no engine: each test file that runs it passes one.

import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import type { OfferContents } from '@kuiralabs/midnight-cli-core';
import { NotAnOfferError } from '@kuiralabs/midnight-cli-core/engine';
import { ledgerTx, type Ledger } from './ledger-tx.ts';
import { OFFER_GIVE, OFFER_WANT, SWAP_OFFER_HEX } from './fixtures/swap-offer.ts';

export interface OfferReaderEngine {
  set: string;
  ledger: Ledger;
  readOffer(txHex: string): OfferContents;
  spentNullifiers(txHex: string): string[];
}

export function offerReaderSuite(engine: OfferReaderEngine): void {
  const { agentPaysMerchant, sealedBytes, unsealedBytes } = ledgerTx(engine.ledger);
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  let payment: string;
  let unsealedPayment: string;
  beforeAll(async () => {
    payment = hex(await sealedBytes(agentPaysMerchant()));
    unsealedPayment = hex(await unsealedBytes(agentPaysMerchant()));
  });

  describe(`the offer reader (${engine.set} engine)`, () => {
    it('reads an offer\'s terms, id and coins from its bytes alone', () => {
      const offer = engine.readOffer(SWAP_OFFER_HEX);
      expect(offer.terms).toEqual({ give: { token: OFFER_GIVE, amount: 10n }, want: { token: OFFER_WANT, amount: 7n } });
      expect(offer.id).toBe(createHash('sha256').update(Buffer.from(SWAP_OFFER_HEX, 'hex')).digest('hex'));
      expect(offer.nullifiers).toHaveLength(1);
      expect(offer.nullifiers[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('names the coins an offer spends, as it names them for any transaction', () => {
      expect(engine.spentNullifiers(SWAP_OFFER_HEX)).toEqual(engine.readOffer(SWAP_OFFER_HEX).nullifiers);
      expect(engine.spentNullifiers(payment)).toEqual([]);
      expect(engine.spentNullifiers(unsealedPayment)).toEqual([]);
    });

    it.each([
      ['text that is not hex', () => 'zswapoffer1qq', 'it is not hex'],
      ['bytes that are no transaction', () => 'deadbeef', 'it is not a sealed ledger-9 transaction'],
      ['a truncated offer', () => SWAP_OFFER_HEX.slice(0, SWAP_OFFER_HEX.length - 64), 'it is not a sealed ledger-9 transaction'],
      ['an unsealed transaction', () => unsealedPayment, 'it is not a sealed ledger-9 transaction'],
      ['an unshielded payment', () => payment, 'a swap offer has shielded parts only'],
    ])('refuses %s as no offer', (_case, tx, reason) => {
      expect(() => engine.readOffer(tx())).toThrow(NotAnOfferError);
      expect(() => engine.readOffer(tx())).toThrow(reason);
    });
  });
}
