// A contract's state read without its compiled contract comes out as plain
// JSON describing the runtime's state tree, not as the WASM object's handle.
// The states are built with the real runtime the indexer decodes into.

import { describe, expect, it } from 'vitest';
import { ChargedState, ContractState, StateBoundedMerkleTree, StateMap, StateValue } from '@midnight-ntwrk/compact-runtime';
import { describeRawState } from '../lib/contract/raw-state.ts';

const atom = (bytes: number[]) => ({ value: [new Uint8Array(bytes)], alignment: [{ tag: 'atom' as const, value: { tag: 'bytes' as const, length: bytes.length } }] });

describe('describeRawState', () => {
  it('describes a contract ledger: cells in hex, a map by size, nested arrays by item', () => {
    const map = new StateMap().insert(atom([1]), StateValue.newCell(atom([7]))).insert(atom([2]), StateValue.newNull());
    const inner = StateValue.newArray().arrayPush(StateValue.newNull());
    const ledger = StateValue.newArray()
      .arrayPush(StateValue.newCell(atom([0x01, 0xab])))
      .arrayPush(StateValue.newMap(map))
      .arrayPush(inner);
    const contract = new ContractState();
    contract.data = new ChargedState(ledger);

    const raw = describeRawState(contract.data.state);

    expect(raw).toEqual({
      type: 'array',
      items: [
        { type: 'cell', value: ['01ab'] },
        { type: 'map', size: 2 },
        { type: 'array', items: [{ type: 'null' }] },
      ],
    });
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });

  it('describes a bounded Merkle tree by height and root', () => {
    const empty = describeRawState(StateValue.newBoundedMerkleTree(new StateBoundedMerkleTree(4)));
    expect(empty).toMatchObject({ type: 'boundedMerkleTree', height: 4 });
    // An empty tree's root is zero: one atom of no bytes.
    expect(describeRawState(StateValue.newBoundedMerkleTree(new StateBoundedMerkleTree(4).rehash()))).toEqual({ type: 'boundedMerkleTree', height: 4, root: [''] });
    const rehashed = describeRawState(StateValue.newBoundedMerkleTree(new StateBoundedMerkleTree(4).update(0n, atom([0x2a])).rehash()));
    // A rehashed tree has a root: field-aligned bytes in hex, none of them empty.
    expect(rehashed.type).toBe('boundedMerkleTree');
    const root = rehashed.type === 'boundedMerkleTree' ? rehashed.root : null;
    expect(root?.length).toBeGreaterThan(0);
    for (const part of root ?? []) expect(part).toMatch(/^[0-9a-f]+$/);
  });
});
