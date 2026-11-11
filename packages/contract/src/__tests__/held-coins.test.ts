// The coins a call may give a contract are its circuit's ShieldedCoinInfo
// arguments; and a call whose private arguments came on the command line is
// warned about.

import { describe, expect, it } from 'vitest';
import { heldCoinArgumentsOf, HELD_COINS_KEY } from '../lib/contract/held-coins.ts';
import { inlinePrivateArgumentsWarning } from '../commands/contract.ts';
import type { CircuitInfo } from '../lib/contract/inspect.ts';

const BYTES32 = { 'type-name': 'Bytes', length: 32 };
const COIN = { 'type-name': 'Struct', name: 'ShieldedCoinInfo', elements: [] };
const QUALIFIED = { 'type-name': 'Struct', name: 'QualifiedShieldedCoinInfo', elements: [] };
const circuit = (name: string, args: [string, object][]): CircuitInfo => ({ name, pure: false, proof: true, arguments: args.map(([n, type]) => ({ name: n, type: type as CircuitInfo['result-type'] })), 'result-type': { 'type-name': 'Tuple', types: [] } });

describe('heldCoinArgumentsOf', () => {
  it('names each ShieldedCoinInfo argument by place and name, and nothing else', () => {
    const info = { circuits: [circuit('lock', [['coin', COIN], ['unlock', BYTES32], ['change', COIN]]), circuit('spend', [['coin', QUALIFIED]])] };
    expect(heldCoinArgumentsOf(info, 'lock')).toEqual([{ index: 0, name: 'coin' }, { index: 2, name: 'change' }]);
    expect(heldCoinArgumentsOf(info, 'spend')).toEqual([]);
    expect(heldCoinArgumentsOf(info, 'nope')).toEqual([]);
    expect(HELD_COINS_KEY).toBe('mnHeldCoins');
  });
});

describe('inlinePrivateArgumentsWarning', () => {
  it('warns when --args gave arguments the circuit keeps private, naming them, and not otherwise', () => {
    expect(inlinePrivateArgumentsWarning({ circuit: 'withdraw', argsSource: 'inline', privateArguments: ['nonce'] }))
      .toBe('withdraw\'s proof keeps its argument "nonce" private, and --args (an MCP tool\'s args) put it on the command line, where other users see it in ps and the shell keeps it in its history, or in the agent\'s transcript. Give private arguments with --args-file <path> (an MCP tool\'s args-file) or --args - (the standard input).');
    expect(inlinePrivateArgumentsWarning({ circuit: 'lock', argsSource: 'inline', privateArguments: ['coin', 'salt'] })).toContain('its arguments "coin", "salt" private, and --args (an MCP tool\'s args) put them on the command line');
    expect(inlinePrivateArgumentsWarning({ circuit: 'withdraw', argsSource: 'file', privateArguments: ['nonce'] })).toBeUndefined();
    expect(inlinePrivateArgumentsWarning({ circuit: 'withdraw', argsSource: 'stdin', privateArguments: ['nonce'] })).toBeUndefined();
    expect(inlinePrivateArgumentsWarning({ circuit: 'withdraw', argsSource: 'inline', privateArguments: [] })).toBeUndefined();
    expect(inlinePrivateArgumentsWarning({ circuit: 'withdraw', argsSource: 'inline' })).toBeUndefined();
  });
});
