// What `mn grant` is asked to do, checked from its arguments alone.

import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '@kuiralabs/midnight-cli-core';
import { describeGrantTerms, paysAFee, resolveGrantRequest } from '../lib/grant/request.ts';

const request = (...argv: string[]) => resolveGrantRequest(parseArgs(['grant', ...argv]));
const LINK = 'midnight-example:grant-request?r=AAECAw';
const GRANT_ID = 'b1a9094fd044707d484a0193c1aa35a8e15bcf513a33b98a624a24739069fbde';
const TOKEN = '02005c8a9e3d6e3a2b0e1c4f7d9a8b6c5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';

describe('resolveGrantRequest', () => {
  it('reads each subcommand', () => {
    expect(request('deploy')).toEqual({ subcommand: 'deploy' });
    expect(request('export', 'alice.backup.json')).toEqual({ subcommand: 'export', file: 'alice.backup.json' });
    expect(request('import', 'alice.backup.json')).toEqual({ subcommand: 'import', file: 'alice.backup.json' });
    expect(() => request('export')).toThrow(/Missing the backup file/);
    expect(paysAFee(request('export', 'f'))).toBe(false);
    expect(paysAFee(request('import', 'f'))).toBe(false);
    const code = `mn-device:v1:${'0a'.repeat(32)}:${'0b'.repeat(32)}:${'0c'.repeat(32)}`;
    expect(request('device', 'new')).toEqual({ subcommand: 'device', action: 'new' });
    expect(request('device', 'list')).toEqual({ subcommand: 'device', action: 'list' });
    expect(request('device', 'add', code, '--backup', 'b.json')).toEqual({ subcommand: 'device', action: 'add', code, backup: 'b.json' });
    expect(request('device', 'remove', code)).toEqual({ subcommand: 'device', action: 'remove', code });
    expect(request('device', 'add', code)).toEqual({ subcommand: 'device', action: 'add', code });
    expect(() => request('device', 'add', 'not-a-code', '--backup', 'b.json')).toThrow(/Not a device code/);
    expect(() => request('device')).toThrow(/device action/);
    expect(() => request('device', 'remove', code, '--backup', 'b.json')).toThrow(/--backup only applies/);
    expect(paysAFee(request('device', 'add', code, '--backup', 'b.json'))).toBe(true);
    expect(paysAFee(request('device', 'remove', code))).toBe(true);
    expect(paysAFee(request('device', 'new'))).toBe(false);
    expect(request('status')).toEqual({ subcommand: 'status' });
    expect(request('list')).toEqual({ subcommand: 'list' });
    expect(request('revoke-all')).toEqual({ subcommand: 'revoke-all' });
    expect(request('revoke', '3')).toEqual({ subcommand: 'revoke', target: '3' });
    expect(request('revoke', GRANT_ID)).toEqual({ subcommand: 'revoke', target: GRANT_ID });
  });

  it('reads a deposit in NIGHT, and its value in the smallest unit the account counts in', () => {
    expect(request('deposit', '2')).toEqual({ subcommand: 'deposit', amount: '2', value: '2000000' });
    expect(request('deposit', '0.3')).toEqual({ subcommand: 'deposit', amount: '0.3', value: '300000' });
    expect(request('deposit', '0.000001')).toEqual({ subcommand: 'deposit', amount: '0.000001', value: '1' });
  });

  it('reads a deposit of another token with --token: its raw type lower-cased, the amount in its smallest unit, exactly', () => {
    expect(request('deposit', '500', '--token', TOKEN)).toEqual({ subcommand: 'deposit', amount: '500', value: '500', token: TOKEN });
    expect(request('deposit', '1', '--token', TOKEN.toUpperCase())).toEqual({ subcommand: 'deposit', amount: '1', value: '1', token: TOKEN });
    // Past a JS number's exact range (2^53) and at a shielded coin's largest value (2^128 - 1): read digit for digit.
    expect(request('deposit', '9007199254740993', '--token', TOKEN)).toMatchObject({ value: '9007199254740993' });
    expect(request('deposit', '340282366920938463463374607431768211455', '--token', TOKEN)).toMatchObject({ value: '340282366920938463463374607431768211455' });
    expect(paysAFee(request('deposit', '500', '--token', TOKEN))).toBe(true);
  });

  it('reads an issue: the link, the limits given, and whether it is confirmed', () => {
    expect(request('issue', LINK)).toEqual({ subcommand: 'issue', link: LINK, limits: {}, confirmed: false });
    expect(request('issue', LINK, '--cap', '500000', '--per-call', '300000', '--max-coin', '2000000', '--expires-in', '3600', '--yes')).toEqual({
      subcommand: 'issue', link: LINK, confirmed: true,
      limits: { cap: '500000', perCall: '300000', maxCoin: '2000000', expiresIn: '3600' },
    });
  });

  it.each([
    [[], 'Usage: midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all|export|import|device>'],
    [['grants'], 'Usage: midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all|export|import|device>'],
    [['status', 'extra'], 'midnight grant status takes no argument; unexpected: extra'],
    [['deploy', 'now'], 'midnight grant deploy takes no argument; unexpected: now'],
    [['issue'], 'Missing the grant request link.'],
    [['issue', '--yes', LINK], 'Put --yes after the grant request link'],
    [['issue', LINK, 'another'], 'midnight grant issue takes one grant request link; unexpected: another'],
    [['issue', LINK, '--cap', '1.5'], '--cap must be a whole number; got "1.5"'],
    [['issue', LINK, '--per-call', '-5'], '--per-call must be a whole number; got "-5"'],
    [['issue', LINK, '--expires-in', '0'], '--expires-in must be at least 1 second'],
    [['deposit'], 'Missing the amount of NIGHT to deposit.'],
    [['deposit', '2', '3'], 'midnight grant deposit takes one amount of NIGHT; unexpected: 3'],
    [['deposit', '0'], 'Invalid amount: "0" — must be greater than 0'],
    [['deposit', '1.0000001'], 'NIGHT has 6 decimals, this has 7'],
    [['deposit', 'all'], 'Invalid amount: "all"'],
    [['deposit', '2', '--yes'], '--yes only applies to: midnight grant issue'],
    [['deposit', '5', '--token', TOKEN.slice(1)], `--token must be a token type, 64 hex characters, not "${TOKEN.slice(1)}"`],
    [['deposit', '5', '--token', `${TOKEN.slice(1)}g`], '--token must be a token type, 64 hex characters'],
    [['deposit', '5', '--token', `0x${TOKEN}`], '--token must be a token type, 64 hex characters'],
    [['deposit', '5', '--token'], '--token needs a value'],
    [['deposit', '5', '--token', '00'.repeat(32)], '--token names NIGHT, which a deposit takes without it'],
    [['deposit', '--token', TOKEN], 'Missing the amount of the token to deposit, in its smallest unit.'],
    [['deposit', '5', '6', '--token', TOKEN], 'midnight grant deposit takes one amount of the token; unexpected: 6'],
    [['deposit', '1.5', '--token', TOKEN], 'With --token the amount is a whole number of the token\'s smallest unit, above 0, not "1.5"'],
    [['deposit', '0', '--token', TOKEN], 'above 0, not "0"'],
    [['deposit', '-3', '--token', TOKEN], 'above 0, not "-3"'],
    [['deposit', '1e6', '--token', TOKEN], 'above 0, not "1e6"'],
    [['status', '--token', TOKEN], '--token only applies to: midnight grant deposit'],
    [['revoke'], 'Missing the grant to revoke.'],
    [['revoke', 'the-first-one'], 'A grant is named by its id (64 hex characters) or its slot (a number); got "the-first-one"'],
    [['status', '--yes'], '--yes only applies to: midnight grant issue'],
    [['revoke', '3', '--cap', '5'], '--cap only applies to: midnight grant issue'],
  ])('refuses %j as a usage mistake', (argv, message) => {
    expect(() => request(...argv)).toThrow(UsageError);
    expect(() => request(...argv)).toThrow(message);
  });
});

describe('paysAFee', () => {
  it('is true of what submits transactions, false of what only reads', () => {
    expect(paysAFee(request('deploy'))).toBe(true);
    expect(paysAFee(request('deposit', '1'))).toBe(true);
    expect(paysAFee(request('revoke', '0'))).toBe(true);
    expect(paysAFee(request('revoke-all'))).toBe(true);
    expect(paysAFee(request('issue', LINK, '--yes'))).toBe(true);
    expect(paysAFee(request('issue', LINK))).toBe(false);
    expect(paysAFee(request('status'))).toBe(false);
    expect(paysAFee(request('list'))).toBe(false);
  });
});

describe('describeGrantTerms', () => {
  it('says every field the account package reports, under the package\'s name for it', () => {
    expect(describeGrantTerms({ clientId: 'rdns:example.agent', slot: 1, payee: 'coin key ab12', cap: '250000', expires: '2026-10-13T01:07:14.000Z' }))
      .toBe('clientId rdns:example.agent, slot 1, payee coin key ab12, cap 250000, expires 2026-10-13T01:07:14.000Z');
  });

  it('keeps a field it has never heard of, and one that isn\'t text', () => {
    expect(describeGrantTerms({ cap: '5', renewable: false, object: { color: '00' } })).toBe('cap 5, renewable false, object {"color":"00"}');
  });

  it('refuses to describe nothing: a user can\'t confirm terms that aren\'t there', () => {
    for (const nothing of [undefined, null, {}, [], 'cap 5']) {
      expect(() => describeGrantTerms(nothing)).toThrow('The account package reported no terms for this grant request.');
    }
  });
});
