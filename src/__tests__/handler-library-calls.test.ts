// What a command does is one library function a program can call too; its
// handler parses the arguments, calls it, and prints. For the commands whose
// work became library functions (part 3E), each handler calls the function of
// each of its operations once, imported from a library module, and reaches
// nothing below it: no engine (`engines.for(`, an engine's wallet or other
// part), no payer (its connect, serve or funds check), no receipt read. Read
// from the source with strings and comments blanked.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeOnly } from '../../scripts/check-process-safety.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

/** Each handler in scope, and the library function of each of its operations. */
const HANDLERS: Record<string, string[]> = {
  'src/commands/balance.ts': ['readAddressBalance', 'readWalletBalance'],
  'src/commands/transfer.ts': ['transferNight'],
  'src/commands/airdrop.ts': ['airdropNight'],
  'src/commands/dust.ts': ['readDustStatus', 'registerDust', 'exportDustSnapshot'],
  'src/commands/contract.ts': ['deployContract', 'callContract', 'readContractState'],
  'src/commands/swap.ts': ['makeSwapOffer', 'inspectSwapOffer', 'takeSwapOffer', 'cancelSwapOffer', 'listSwapOffers'],
  'packages/chain/src/commands/tx.ts': ['transactionStatus'],
};

/** What only a library function may call, by what it looks like in the code. */
const BELOW_A_HANDLER: Record<string, RegExp> = {
  'the host\'s engines': /\bengines\s*\.\s*(for|load|any)\s*\(/,
  'an engine\'s wallet': /\.\s*wallet\s*\.\s*\w+\s*\(/,
  'an engine\'s keys, ledger, contracts or readers': /\.\s*(keys|ledger|contracts|readers)\s*\.\s*\w+/,
  'a payer\'s wallet session': /\.\s*connect\s*\(/,
  'a payer\'s served wallet': /\.\s*serve\s*\(/,
  'a payer\'s funds check': /\.\s*assertCanPay\s*\(/,
  'a receipt': /\breceiptOf\s*\(/,
};

const sourceOf = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

describe.each(Object.entries(HANDLERS))('%s', (file, functions) => {
  const source = sourceOf(file);
  const code = codeOnly(source);

  it.each(functions)('calls %s once, imported from a library module', (name) => {
    expect(code.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) ?? []).toHaveLength(1);
    const imported = [...source.matchAll(/^import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)]
      .filter(([, names]) => names!.split(',').some((each) => each.trim() === name))
      .map(([, , from]) => from);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/\/lib\//);
  });

  it('reaches nothing below a library function', () => {
    const found = Object.entries(BELOW_A_HANDLER).filter(([, site]) => site.test(code)).map(([what]) => what);
    expect(found).toEqual([]);
  });
});

describe('the check', () => {
  it('finds each kind of call below a library function', () => {
    const below = [
      'await (await ctx.host.engines.for(network)).wallet.transfer(options);',
      'const session = await payerFor("swap make", ctx).connect(target, wallet, spinner, warnings, signal);',
      'await payer.serve(target, wallet, spinner, warnings, signal);',
      'await payer.assertCanPay(target, wallet, spinner, signal);',
      'const receipt = await receiptOf(indexer, txHash, signal);',
      'const raw = await engine.contracts.rawState(config, address);',
    ];
    for (const line of below) expect(Object.values(BELOW_A_HANDLER).some((site) => site.test(line)), line).toBe(true);
    expect(Object.values(BELOW_A_HANDLER).some((site) => site.test('const { network } = networkChoiceFromArgs(args); ctx.output.result(receiptJson(receipt));'))).toBe(false);
  });
});
