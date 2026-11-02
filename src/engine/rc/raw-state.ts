// A deployed contract's ledger state, read without its compiled contract: the
// untyped tree the chain stores, as plain JSON. Without the contract's ledger
// layout the fields have no names, so cells show their field-aligned bytes in
// hex and maps show their size, as the parsed state does.

import type { RawStateValue } from '../../lib/engine.ts';

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** The parts of the runtime's `StateValue` read here (the runtime version the indexer decodes with varies). */
interface StateValueLike {
  type(): 'null' | 'cell' | 'map' | 'array' | 'boundedMerkleTree';
  asCell(): { value: Uint8Array[] };
  asMap(): { keys(): unknown[] } | undefined;
  asArray(): StateValueLike[] | undefined;
  asBoundedMerkleTree(): { height: number; root(): { value: Uint8Array[] } | undefined } | undefined;
}

export function describeRawState(state: StateValueLike): RawStateValue {
  switch (state.type()) {
    case 'null':
      return { type: 'null' };
    case 'cell':
      return { type: 'cell', value: state.asCell().value.map(toHex) };
    case 'array':
      return { type: 'array', items: (state.asArray() ?? []).map(describeRawState) };
    case 'map':
      return { type: 'map', size: state.asMap()?.keys().length ?? 0 };
    case 'boundedMerkleTree': {
      const tree = state.asBoundedMerkleTree();
      return { type: 'boundedMerkleTree', height: tree?.height ?? 0, root: tree?.root()?.value.map(toHex) ?? null };
    }
  }
}
