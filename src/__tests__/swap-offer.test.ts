// The terms check a taker runs before building or spending anything, and how
// its refusals classify: the caller's to fix.

import { describe, it, expect } from 'vitest';
import { checkTerms, NotAnOfferError, TermsMismatchError, type SwapTerms } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { classifyError, ERROR_CODES, EXIT_INVALID_ARGS } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { installedCommands } from '../lib/installed-commands.ts';

const A = '00'.repeat(31) + '01';
const B = '00'.repeat(31) + '02';
const AGREED: SwapTerms = { give: { token: A, amount: 10n }, want: { token: B, amount: 7n } };

describe('checkTerms', () => {
  it('passes an offer whose terms are exactly the agreed ones, whatever the case of the token hex', () => {
    expect(() => checkTerms({ give: { token: A.toUpperCase(), amount: 10n }, want: { token: B, amount: 7n } }, AGREED)).not.toThrow();
  });

  it.each([
    ['gives less', { give: { token: A, amount: 9n }, want: { token: B, amount: 7n } }],
    ['wants more', { give: { token: A, amount: 10n }, want: { token: B, amount: 8n } }],
    ['gives another token', { give: { token: B, amount: 10n }, want: { token: B, amount: 7n } }],
    ['swaps the sides', { give: { token: B, amount: 7n }, want: { token: A, amount: 10n } }],
  ])('refuses an offer that %s, saying what it offers and what was agreed', (_case, offered) => {
    const err = (() => { try { checkTerms(offered, AGREED); } catch (e) { return e; } })() as TermsMismatchError;
    expect(err).toBeInstanceOf(TermsMismatchError);
    expect(err.offered).toEqual(offered);
    expect(err.message).toBe(`The offer gives ${offered.give.amount} of token ${offered.give.token} for ${offered.want.amount} of token ${offered.want.token}, not the agreed 10 of token ${A} for 7 of token ${B}`);
  });

  it('classifies a terms mismatch and bytes that are no offer as the caller\'s to fix', () => {
    expect(classifyError(new TermsMismatchError(AGREED, AGREED), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.TERMS_MISMATCH });
    expect(classifyError(new NotAnOfferError('it is not hex'), installedCommands)).toEqual({ exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.NOT_AN_OFFER });
  });
});
