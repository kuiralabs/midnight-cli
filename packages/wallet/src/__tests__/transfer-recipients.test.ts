// A transfer's recipients as written: pairs on the command line and the
// entries of a --to-file, checked for their shape alone. Files are written
// under a temporary folder.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { UsageError } from '@kuiralabs/midnight-cli-core';
import { assertRecipientCount, MAX_TRANSFER_RECIPIENTS, readRecipientsFile, recipientPairsOf } from '../lib/transfer-recipients.ts';

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-transfer-recipients-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function file(name: string, contents: string): string {
  const at = path.join(dir, name);
  fs.writeFileSync(at, contents);
  return at;
}

describe('recipientPairsOf', () => {
  it('reads one pair as today\'s transfer, and several in order, a recipient listed twice kept twice', () => {
    expect(recipientPairsOf(['alice', '10'])).toStrictEqual([{ to: 'alice', amount: '10' }]);
    expect(recipientPairsOf(['alice', '10', 'bob', '5', 'alice', '2.5'])).toStrictEqual([
      { to: 'alice', amount: '10' }, { to: 'bob', amount: '5' }, { to: 'alice', amount: '2.5' },
    ]);
  });

  it('refuses no words and a lone recipient with today\'s messages', () => {
    expect(() => recipientPairsOf([])).toThrow(/^Missing recipient address\.\nUsage: midnight transfer <to> <amount>\n/);
    expect(() => recipientPairsOf(['alice'])).toThrow(/^Missing amount\.\nUsage: midnight transfer <to> <amount>\n/);
  });

  it('refuses an odd number of words, naming the recipient without an amount', () => {
    expect(() => recipientPairsOf(['alice', '10', 'bob'])).toThrow(UsageError);
    expect(() => recipientPairsOf(['alice', '10', 'bob'])).toThrow('Recipient 2 of 2 ("bob") has no amount: give each recipient an amount.');
    expect(() => recipientPairsOf(['alice', '10', 'bob', '5', 'carol'])).toThrow('Recipient 3 of 3 ("carol") has no amount');
  });
});

describe('assertRecipientCount', () => {
  it('takes one to the cap', () => {
    expect(() => assertRecipientCount(1)).not.toThrow();
    expect(() => assertRecipientCount(MAX_TRANSFER_RECIPIENTS)).not.toThrow();
  });

  it('refuses none and one past the cap, as usage mistakes', () => {
    expect(() => assertRecipientCount(0)).toThrow(UsageError);
    expect(() => assertRecipientCount(0)).toThrow('The transfer lists no recipients');
    expect(() => assertRecipientCount(MAX_TRANSFER_RECIPIENTS + 1)).toThrow(UsageError);
    expect(() => assertRecipientCount(MAX_TRANSFER_RECIPIENTS + 1)).toThrow(`Too many recipients: ${MAX_TRANSFER_RECIPIENTS + 1}, at most ${MAX_TRANSFER_RECIPIENTS} in one transfer.`);
  });
});

describe('readRecipientsFile', () => {
  it('reads the entries in order', () => {
    const at = file('payments.json', JSON.stringify([{ to: 'alice', amount: '10' }, { to: 'mn_addr_undeployed1x', amount: '2.5' }]));
    expect(readRecipientsFile(at)).toStrictEqual([{ to: 'alice', amount: '10' }, { to: 'mn_addr_undeployed1x', amount: '2.5' }]);
  });

  it.each([
    ['a file that is not there', null, 'Cannot read the recipients file', 'no such file'],
    ['text that is not JSON', '[{"to": "alice",', 'is not valid JSON', 'Expected: [{"to"'],
    ['JSON that is not an array', '{"to": "alice", "amount": "1"}', 'must hold a JSON array of recipients', 'Expected: [{"to"'],
    ['an empty array', '[]', 'lists no recipients', 'Expected: [{"to"'],
    ['an entry that is not an object', '[{"to": "alice", "amount": "1"}, "bob"]', 'Entry 2 of 2 in', 'is not an object with "to" and "amount"'],
    ['an entry with no recipient', '[{"amount": "1"}]', 'Entry 1 of 1 in', 'has no "to"'],
    ['an entry with no amount', '[{"to": "alice"}]', 'Entry 1 of 1 in', '("alice") has no "amount"'],
    ['an amount that is a number, not a string', '[{"to": "alice", "amount": 2.5}]', 'Entry 1 of 1 in', '"amount" 2.5, not a string: give the NIGHT as a string, such as "2.5"'],
    ['an entry with a field a recipient does not take', '[{"to": "alice", "amount": "1", "memo": "rent"}]', 'Entry 1 of 1 in', 'has "memo", which a recipient doesn\'t take'],
  ])('refuses %s as a usage mistake, saying what is wrong', (_case, contents, where, why) => {
    const at = contents === null ? path.join(dir, 'missing.json') : file('payments.json', contents);
    let err: unknown;
    try { readRecipientsFile(at); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain(where);
    expect((err as Error).message).toContain(why);
    expect((err as Error).message).toContain(at);
  });
});
