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
    const rehashed = describeRawState(StateValue.newBoundedMerkleTree(new StateBoundedMerkleTree(4).rehash()));
    expect(rehashed.type === 'boundedMerkleTree' && rehashed.root?.every((part) => /^[0-9a-f]*$/.test(part))).toBe(true);
  });
});
