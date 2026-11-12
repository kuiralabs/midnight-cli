// Transaction hex helpers — the DApp Connector passes transactions as hex
// strings over JSON-RPC. Reading the bytes as a transaction is the wallet's
// job (`facade.adoptTransaction`), which knows the chain's ledger version.

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hex characters');
  }
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

/** A transaction's stage, as the DApp connector names it: not yet proven; proven and not bound; proven and bound. */
export type TransactionStageName = 'unproven' | 'unsealed' | 'sealed';

const STAGE_WORDS: Record<TransactionStageName, string> = {
  unproven: 'an unproven transaction (not yet proven)',
  unsealed: 'an unsealed transaction (proven, not yet bound)',
  sealed: 'a sealed transaction (proven and bound)',
};

// The ledger writes a tag before a transaction's bytes, e.g.
// "midnight:transaction[v12](signature[v2],proof,pedersen-schnorr[v1]):"; its
// proof and binding markers say the stage.
const TRANSACTION_TAG = /^midnight:transaction\[(v\d+)\]\(([^)]*)\):/;

/**
 * What the bytes' ledger tag says they are: a transaction (its tag's version
 * and, when the markers are ones mn knows, its stage), or undefined when they
 * don't start with a transaction's tag at all.
 */
export function readTransactionTag(bytes: Uint8Array): { version: string; stage: TransactionStageName | undefined } | undefined {
  const head = Buffer.from(bytes.subarray(0, 128)).toString('latin1');
  const match = TRANSACTION_TAG.exec(head);
  if (match === null) return undefined;
  const [, proof, binding] = match[2].split(',');
  const stage: TransactionStageName | undefined = proof === 'proof-preimage' && binding?.startsWith('embedded-fr') ? 'unproven'
    : proof === 'proof' && binding?.startsWith('embedded-fr') ? 'unsealed'
      : proof === 'proof' && binding?.startsWith('pedersen-schnorr') ? 'sealed'
        : undefined;
  return { version: match[1], stage };
}

/**
 * Why `hex` can't be read as `expected`, when its own bytes say so: it isn't
 * hex, isn't a transaction, or is one at another stage. Undefined when it is a
 * transaction at the expected stage (or one mn can't tell), so the reader's
 * own failure, such as another ledger version, is the reason.
 */
export function transactionMismatch(hex: string, expected: TransactionStageName): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = fromHex(hex);
  } catch (err) {
    return `The transaction is not hex (${(err as Error).message.replace(/^Invalid hex string: /, '')}): pass ${STAGE_WORDS[expected]}, serialized, as hex.`;
  }
  const tag = readTransactionTag(bytes);
  if (tag === undefined) {
    return `These bytes are not a serialized Midnight transaction (they don't start with the ledger's transaction tag): pass ${STAGE_WORDS[expected]}, serialized, as hex.`;
  }
  if (tag.stage !== undefined && tag.stage !== expected) {
    return `This is ${STAGE_WORDS[tag.stage]}, and this takes ${STAGE_WORDS[expected]}.`;
  }
  return undefined;
}
