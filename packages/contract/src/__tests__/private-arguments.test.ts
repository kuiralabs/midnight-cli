// Which of a circuit's arguments its proof keeps private, read from its ZK IR:
// an argument none of whose wires the public transcript takes as it is. The
// IR here is the shape compactc 0.36 writes (an escrow's lock and withdraw).

import { describe, expect, it } from 'vitest';
import { privateArgumentsOf } from '../lib/contract/private-arguments.ts';

const BYTES32 = { 'type-name': 'Bytes', length: 32 };
const zkir = (inputs: string[], instructions: object[], outputs: string[] = []) => JSON.stringify({
  version: { major: 3, minor: 1 },
  inputs: inputs.map((name) => ({ name, type: 'Scalar<BLS12-381>' })),
  outputs,
  instructions,
});
const reader = (files: Record<string, string>) => (path: string): string => {
  const name = Object.keys(files).find((file) => path.endsWith(file));
  if (name === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return files[name]!;
};

describe('privateArgumentsOf', () => {
  it('sees an argument the transcript takes as it is go public, and one only hashed stay private', () => {
    const files = {
      // withdraw(id): id is a map key in the public transcript.
      'zkir/withdraw.zkir': zkir(['%id.0', '%id.1'], [
        { op: 'constrain_bits', val: '%id.0', bits: 8 },
        { op: 'impact', guard: '0x01', inputs: ['0x10', '0x01', '0x01', '0x20', '%id.0', '%id.1'] },
      ]),
      // reveal(nonce): only a hash of the nonce goes public.
      'zkir/reveal.zkir': zkir(['%nonce.0', '%nonce.1'], [
        { op: 'persistent_hash', output: '%bytes.2', alignment: [], inputs: ['0x00', '%nonce.0', '%nonce.1'] },
        { op: 'bytes_into_natives', outputs: ['%t.3', '%t.4'], bytes: '%bytes.2' },
        { op: 'impact', guard: '0x01', inputs: ['0x10', '%t.3', '%t.4'] },
      ]),
      // lock(coin, unlock): the coin's value never goes public, the unlock time does.
      'zkir/lock.zkir': zkir(['%coin.0', '%coin.1', '%coin.2', '%coin.3', '%coin.4', '%unlock.5'], [
        { op: 'impact', guard: '0x01', inputs: ['0x10', '%coin.0', '%coin.1', '%coin.2', '%coin.3'] },
        { op: 'less_than', output: '%t.8', a: '0x00', b: '%coin.4', bits: 128 },
        { op: 'impact', guard: '0x01', inputs: ['0x11', '%unlock.5'] },
      ]),
      // get(x): x comes back as the circuit's output.
      'zkir/get.zkir': zkir(['%x.0'], [], ['%x.0']),
    };
    const read = reader(files);
    expect(privateArgumentsOf('/m', { name: 'withdraw', arguments: [{ name: 'id', type: BYTES32 }] }, read)).toEqual([]);
    expect(privateArgumentsOf('/m', { name: 'reveal', arguments: [{ name: 'nonce', type: BYTES32 }] }, read)).toEqual(['nonce']);
    expect(privateArgumentsOf('/m', { name: 'lock', arguments: [{ name: 'coin', type: BYTES32 }, { name: 'unlock', type: BYTES32 }] }, read)).toEqual(['coin']);
    expect(privateArgumentsOf('/m', { name: 'get', arguments: [{ name: 'x', type: BYTES32 }] }, read)).toEqual([]);
  });

  it('can\'t tell, and says nothing, without the ZK IR or when its inputs don\'t name an argument', () => {
    const read = reader({ 'zkir/renamed.zkir': zkir(['%a.0'], []), 'zkir/broken.zkir': '{' });
    expect(privateArgumentsOf('/m', { name: 'missing', arguments: [{ name: 'x', type: BYTES32 }] }, read)).toBeUndefined();
    expect(privateArgumentsOf('/m', { name: 'renamed', arguments: [{ name: 'x', type: BYTES32 }] }, read)).toBeUndefined();
    expect(privateArgumentsOf('/m', { name: 'broken', arguments: [{ name: 'x', type: BYTES32 }] }, read)).toBeUndefined();
  });

  it('tells one argument\'s wires from another whose name starts the same', () => {
    const read = reader({ 'zkir/two.zkir': zkir(['%a.0', '%a_b.1'], [{ op: 'impact', guard: '0x01', inputs: ['%a_b.1'] }]) });
    expect(privateArgumentsOf('/m', { name: 'two', arguments: [{ name: 'a', type: BYTES32 }, { name: 'a_b', type: BYTES32 }] }, read)).toEqual(['a']);
  });
});
