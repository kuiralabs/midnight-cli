// What a `swap` command asks for, read from its arguments and checked before
// any wallet opens: the terms, the expiry, the offer file, the network.

import { readFileSync } from 'node:fs';
import { type ParsedArgs, getFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { type PayingTarget, resolvePayingTarget } from '@kuiralabs/midnight-cli-core/lib/payer';
import type { Host } from '@kuiralabs/midnight-cli-core/lib/host';
import { checkTerms, type SwapLeg, type SwapTerms } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { assertOfferUnexpired } from '@kuiralabs/midnight-cli-core/lib/offer-envelope';
import { readOfferFile, type ReadOffer } from './offers.ts';

/** How long an offer lasts for takers using mn unless the maker says. */
export const DEFAULT_OFFER_LIFETIME_S = 24 * 60 * 60;

function legOf(args: ParsedArgs, side: 'give' | 'want'): SwapLeg {
  const amount = side === 'give' ? getFlag(args, 'give') : getFlag(args, 'want');
  const token = side === 'give' ? getFlag(args, 'give-token') : getFlag(args, 'want-token');
  if (amount === undefined || token === undefined) throw new UsageError(`--${side} and --${side}-token are required: the amount and the shielded token the maker ${side === 'give' ? 'gives' : 'wants back'}`);
  if (!/^[1-9][0-9]*$/.test(amount)) throw new UsageError(`--${side} must be a whole amount of the token's smallest unit, above 0, not "${amount}"`);
  if (!/^[0-9a-fA-F]{64}$/.test(token)) throw new UsageError(`--${side}-token must be a token type, 64 hex characters, not "${token}"`);
  return { token: token.toLowerCase(), amount: BigInt(amount) };
}

/** The terms as the maker states them: --give of --give-token for --want of --want-token. */
export function termsOf(args: ParsedArgs): SwapTerms {
  const terms = { give: legOf(args, 'give'), want: legOf(args, 'want') };
  if (terms.give.token === terms.want.token) throw new UsageError('A swap gives one token for another: --give-token and --want-token are the same');
  return terms;
}

/** What `swap make` asks for besides its network: the terms, the expiry, and where the offer file goes. */
export interface MakeTerms {
  terms: SwapTerms;
  expiresAt: Date;
  /** Where to write the offer file; offer-<id>.json in the working folder when not given. */
  out: string | undefined;
}

export interface MakeRequest extends MakeTerms {
  target: PayingTarget;
}

/** --expires-in seconds on from `now`, a day when not given. */
function expiryOf(args: ParsedArgs, now: Date): Date {
  const lifetime = getFlag(args, 'expires-in') ?? String(DEFAULT_OFFER_LIFETIME_S);
  if (!/^[1-9][0-9]*$/.test(lifetime)) throw new UsageError(`--expires-in must be a whole number of seconds above 0, not "${lifetime}"`);
  return new Date(now.getTime() + Number(lifetime) * 1000);
}

/** The terms, the expiry from `now` and the offer file `swap make` names, without its network. */
export function makeTermsOf(args: ParsedArgs, now: Date): MakeTerms {
  const expiresAt = expiryOf(args, now);
  return { terms: termsOf(args), expiresAt, out: getFlag(args, 'out') };
}

/** A make, checked as far as it can be without a wallet: the expiry, the network and the terms. */
export function prepareMake(args: ParsedArgs, root: string, host: Host, now: Date): MakeRequest {
  const expiresAt = expiryOf(args, now);
  return {
    target: resolvePayingTarget(args, 'swap', 'make', root, host),
    terms: termsOf(args),
    expiresAt,
    out: getFlag(args, 'out'),
  };
}

export interface TakeRequest {
  target: PayingTarget;
  offer: ReadOffer;
  agreed: SwapTerms;
}

/** The text of the offer file the first positional names. */
export function readOfferText(args: ParsedArgs): string {
  const file = args.positionals[0];
  if (file === undefined) throw new UsageError(`swap ${args.subcommand} needs the offer file: midnight swap ${args.subcommand} <file>`);
  try {
    return readFileSync(file, 'utf-8');
  } catch (err) {
    throw new UsageError(`Can't read the offer file ${file}: ${(err as Error).message}`);
  }
}

/** The offer file named by the first positional, read for the network. */
export async function readOfferArg(args: ParsedArgs, target: PayingTarget): Promise<ReadOffer> {
  return readOfferFile(target.root, readOfferText(args), target.network, target.host.engines);
}

/** A take, checked as far as it can be without the chain: the file, its network, the agreed terms and the expiry. */
export async function prepareTake(args: ParsedArgs, root: string, host: Host, now: Date): Promise<TakeRequest> {
  const target = resolvePayingTarget(args, 'swap', 'take', root, host);
  const agreed = termsOf(args);
  const offer = await readOfferArg(args, target);
  checkTerms(offer.contents.terms, agreed);
  assertOfferUnexpired(offer.envelope, now);
  return { target, offer, agreed };
}
