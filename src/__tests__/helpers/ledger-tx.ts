// Real ledger-v9 transactions built offline, as a dApp would hand them to the
// connector: one intent at segment 1 with unshielded offers, signed over the
// intent's real signature data, proven (there is nothing to prove) and
// serialized at the stage the dApp sends.
//
// Built over a given copy of the ledger (`ledgerTx`), since each SDK engine
// reads transactions with its own; the exports below are over the rc
// engine's, the copy at the root.

import * as rcLedger from '@midnightntwrk/ledger-v9';
import type {
  ProvingProvider,
  SigningKey,
  UnprovenTransaction,
  UtxoOutput,
  UtxoSpend,
} from '@midnightntwrk/ledger-v9';

/** A copy of ledger-v9, as an engine loads it. */
export type Ledger = typeof rcLedger;

export const NETWORK = 'undeployed';
export const TTL = new Date(Date.UTC(2030, 0, 1));

/** These transactions hold no zswap or contract parts, so proving them has nothing to prove. */
const NOTHING_TO_PROVE: ProvingProvider = {
  check: () => { throw new Error('unexpected proof check'); },
  prove: () => { throw new Error('unexpected proof'); },
  lookupKey: () => { throw new Error('unexpected key lookup'); },
};

export interface OfferSpec {
  inputs: UtxoSpend[];
  outputs: UtxoOutput[];
  /** Who signs each input, in order; a missing entry leaves that input unsigned. */
  signers: SigningKey[];
}

/** The keys, builders and serializers, over `ledger`. */
export function ledgerTx(ledger: Ledger) {
  const {
    CostModel, Intent, SignatureEnabled, Transaction, UnshieldedOffer,
    addressFromKey, signData, signatureVerifyingKey, signingKeyFromBip340, unshieldedToken,
  } = ledger;
  const NIGHT = unshieldedToken().raw;
  /** The wallet `mn serve` runs (the fee wallet). */
  const WALLET_SK = signingKeyFromBip340(new Uint8Array(32).fill(1));
  /** The agent: holds its own value, never the wallet's. */
  const AGENT_SK = signingKeyFromBip340(new Uint8Array(32).fill(2));
  const WALLET_VK = signatureVerifyingKey(WALLET_SK);
  const AGENT_VK = signatureVerifyingKey(AGENT_SK);
  const MERCHANT = addressFromKey(signatureVerifyingKey(signingKeyFromBip340(new Uint8Array(32).fill(3))));

  const spend = (owner: SigningKey, value: bigint, outputNo = 0): UtxoSpend => ({
    value, owner: signatureVerifyingKey(owner), type: NIGHT, intentHash: 'ab'.repeat(32), outputNo,
  });
  const pay = (value: bigint): UtxoOutput => ({ value, owner: MERCHANT, type: NIGHT });

  function buildTx(offers: { guaranteed?: OfferSpec; fallible?: OfferSpec }, ttl: Date = TTL): UnprovenTransaction {
    const intent = Intent.new(ttl);
    if (offers.guaranteed) intent.guaranteedUnshieldedOffer = UnshieldedOffer.new(offers.guaranteed.inputs, offers.guaranteed.outputs, []);
    if (offers.fallible) intent.fallibleUnshieldedOffer = UnshieldedOffer.new(offers.fallible.inputs, offers.fallible.outputs, []);
    const data = intent.signatureData(1);
    const sign = (spec: OfferSpec) => spec.signers.map((sk) => new SignatureEnabled(signData(sk, data)));
    if (offers.guaranteed && offers.guaranteed.signers.length > 0) {
      intent.guaranteedUnshieldedOffer = intent.guaranteedUnshieldedOffer!.addSignatures(sign(offers.guaranteed));
    }
    if (offers.fallible && offers.fallible.signers.length > 0) {
      intent.fallibleUnshieldedOffer = intent.fallibleUnshieldedOffer!.addSignatures(sign(offers.fallible));
    }
    return Transaction.fromParts(NETWORK, undefined, undefined, intent);
  }

  /** The agent pays the merchant `value` Night from its own signed input: nothing left for the wallet but the fee. */
  const agentPaysMerchant = (value = 100n) => buildTx({ guaranteed: { inputs: [spend(AGENT_SK, value)], outputs: [pay(value)], signers: [AGENT_SK] } });

  /** The bytes a dApp sends to balanceUnsealedTransaction. */
  async function unsealedBytes(tx: UnprovenTransaction): Promise<Uint8Array> {
    return (await tx.prove(NOTHING_TO_PROVE, CostModel.initialCostModel())).serialize();
  }

  /** The bytes a dApp sends to balanceSealedTransaction. */
  async function sealedBytes(tx: UnprovenTransaction): Promise<Uint8Array> {
    return (await tx.prove(NOTHING_TO_PROVE, CostModel.initialCostModel())).bind().serialize();
  }

  return { NIGHT, WALLET_SK, AGENT_SK, WALLET_VK, AGENT_VK, MERCHANT, spend, pay, buildTx, agentPaysMerchant, unsealedBytes, sealedBytes };
}

export const {
  NIGHT, WALLET_SK, AGENT_SK, WALLET_VK, AGENT_VK, MERCHANT, spend, pay, buildTx, agentPaysMerchant, unsealedBytes, sealedBytes,
} = ledgerTx(rcLedger);
