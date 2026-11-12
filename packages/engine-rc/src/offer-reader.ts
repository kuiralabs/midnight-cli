// Reads a swap offer from its bytes alone, trusting nothing said about it: a
// sealed ledger-9 transaction whose only part is a shielded offer in the
// guaranteed segment, giving one token for one other. And which shielded
// coins any transaction spends, so a wallet's spends can be checked against
// the offers it has open.

import { createHash } from 'node:crypto';
import { Transaction } from '@midnightntwrk/ledger-v9';
import { NotAnOfferError } from '@kuiralabs/midnight-cli-core/engine';
import type { OfferContents } from '@kuiralabs/midnight-cli-core';

export function readOffer(txHex: string): OfferContents {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(txHex)) throw new NotAnOfferError('it is not hex');
  const bytes = Buffer.from(txHex, 'hex');
  let tx;
  try {
    tx = Transaction.deserialize('signature', 'proof', 'binding', bytes);
  } catch (cause) {
    throw new NotAnOfferError('it is not a sealed ledger-9 transaction', { cause });
  }
  const offer = tx.guaranteedOffer;
  if (offer === undefined || (tx.fallibleOffer?.size ?? 0) > 0 || (tx.intents?.size ?? 0) > 0) {
    throw new NotAnOfferError('a swap offer has shielded parts only, in the guaranteed segment');
  }
  // Deltas are inputs minus outputs: what the maker gives is in surplus, what it wants in deficit.
  const gives = [...offer.deltas].filter(([, delta]) => delta > 0n);
  const wants = [...offer.deltas].filter(([, delta]) => delta < 0n);
  if (gives.length !== 1 || wants.length !== 1) {
    throw new NotAnOfferError(`a swap offer gives one token for one other, not ${gives.length} for ${wants.length}`);
  }
  const [[giveToken, give]] = gives;
  const [[wantToken, want]] = wants;
  return {
    id: createHash('sha256').update(bytes).digest('hex'),
    terms: { give: { token: giveToken, amount: give }, want: { token: wantToken, amount: -want } },
    nullifiers: offer.inputs.map((input) => input.nullifier),
  };
}

/**
 * The identifier the wallet SDK's submit returns for a sealed transaction (its
 * last), which mn reports as the `txHash` of a transfer, a swap's take and a
 * cancel; from its bytes (hex). Throws when the bytes aren't a sealed ledger-9
 * transaction with one.
 */
export function transactionIdentifier(txHex: string): string {
  const identifier = Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(txHex, 'hex')).identifiers().at(-1);
  if (identifier === undefined) throw new Error('The transaction has no identifier');
  return identifier;
}

/** The nullifiers of the shielded coins a transaction (hex, sealed or not) spends, in every segment. */
export function spentNullifiers(txHex: string): string[] {
  const bytes = Buffer.from(txHex, 'hex');
  let tx;
  try {
    tx = Transaction.deserialize('signature', 'proof', 'binding', bytes);
  } catch {
    tx = Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
  }
  const offers = [tx.guaranteedOffer, ...(tx.fallibleOffer?.values() ?? [])];
  return offers.flatMap((offer) => offer?.inputs.map((input) => input.nullifier) ?? []);
}
