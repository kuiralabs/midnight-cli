// swap command — private swaps of shielded tokens through offer files
// Usage: midnight swap <make|inspect|take|cancel|list> [options]
//
// The maker's and the taker's wallets each run in this process, through the
// payer's wallet session: no server, no port. inspect and list open no wallet.

import { writeFileSync } from 'node:fs';
import { type ParsedArgs, hasFlag, getFlag, UsageError, networkChoiceFromArgs, payerFor, type CallContext, type SwapLeg, type SwapTerms } from '@kuiralabs/midnight-cli-core';
import { header, keyValue, dim, spinnerReporter } from '@kuiralabs/midnight-cli-core/ui';
import { showPaidStep } from '../lib/wallet/paid-call.ts';
import { makeSwapOffer } from '../lib/swap/make.ts';
import { inspectSwapOffer } from '../lib/swap/inspect.ts';
import { takeSwapOffer } from '../lib/swap/take.ts';
import { cancelSwapOffer } from '../lib/swap/cancel.ts';
import { OfferTakenError } from '../lib/swap/offers.ts';
import { listSwapOffers } from '../lib/swap/list.ts';
import { makeTermsOf, readOfferText, termsOf } from '../lib/swap/request.ts';
import { receiptJson } from '@kuiralabs/midnight-chain';
import { receiptText } from '../ui/receipt.ts';

const legJson = ({ token, amount }: SwapLeg) => ({ token, amount: amount.toString() });
const termsJson = ({ give, want }: SwapTerms) => ({ give: legJson(give), want: legJson(want) });
const legText = ({ token, amount }: SwapLeg) => `${amount} of ${token}`;

export default async function swapCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const progress = spinnerReporter(ctx.progress, jsonMode);
  const walletFlag = getFlag(args, 'wallet');
  const now = new Date();
  const call = { ...networkChoiceFromArgs(args), signal: ctx.signal };
  const paid = { ...call, wallet: walletFlag, sdkWarnings: ctx.sdkWarnings, log: ctx.diagnostics.line };

  switch (args.subcommand) {
    case 'make': {
      // Refuses an offer file that can't be written (it exists, or its folder doesn't or can't be written) before anything is built.
      const { terms, expiresAt, out } = makeTermsOf(args, now);
      const made = await makeSwapOffer(ctx.host, {
        ...paid,
        payer: payerFor('swap make', ctx),
        terms,
        expiresAt,
        now,
        onProgress: (event) => {
          if (event.kind !== 'swap-network') return showPaidStep(progress, event);
          if (jsonMode) return;
          ctx.output.stderr('\n' + header('Swap: make an offer') + '\n\n');
          ctx.output.stderr(keyValue('Network', event.network) + '\n');
          ctx.output.stderr(keyValue('Gives', legText(terms.give)) + '\n');
          ctx.output.stderr(keyValue('Wants', legText(terms.want)) + '\n\n');
        },
      });
      const file = out ?? `offer-${made.id.slice(0, 16)}.json`;
      writeFileSync(file, made.file, { flag: 'wx' });
      if (jsonMode) {
        const split = made.split === undefined ? {} : { split: { txHash: made.split.txHash, ...(made.split.receipt === undefined ? {} : receiptJson(made.split.receipt)) } };
        ctx.output.result({ subcommand: 'make', network: made.network, id: made.id, file, terms: termsJson(made.terms), expiresAt: made.expiresAt.toISOString(), ...split });
        return;
      }
      ctx.output.stdout(file + '\n');
      if (made.split !== undefined) {
        ctx.output.stderr('\n' + keyValue('Split', `${made.split.txHash} (a coin of exactly ${made.terms.give.amount}, for the offer)`) + '\n');
        if (made.split.receipt !== undefined) ctx.output.stderr(receiptText(made.split.receipt, made.split.txHash));
      }
      ctx.output.stderr('\n' + keyValue('Offer', made.id) + '\n');
      ctx.output.stderr(keyValue('File', file) + '\n');
      ctx.output.stderr(keyValue('Expires', made.expiresAt.toISOString()) + '\n');
      ctx.output.stderr('\n' + dim('  Hand the file to the taker. Its coins stay committed until it is taken.') + '\n\n');
      return;
    }

    case 'inspect': {
      const standing = await inspectSwapOffer(ctx.host, { ...call, offer: readOfferText(args), now, onProgress: (event) => progress.report(event) });
      if (jsonMode) {
        ctx.output.result({ subcommand: 'inspect', network: standing.network, id: standing.id, terms: termsJson(standing.terms), expiresAt: standing.expiresAt.toISOString(), live: standing.live, expired: standing.expired });
        return;
      }
      ctx.output.stderr('\n' + header('Swap offer') + '\n\n');
      ctx.output.stderr(keyValue('Offer', standing.id) + '\n');
      ctx.output.stderr(keyValue('Network', standing.network) + '\n');
      ctx.output.stderr(keyValue('Maker gives', legText(standing.terms.give)) + '\n');
      ctx.output.stderr(keyValue('Maker wants', legText(standing.terms.want)) + '\n');
      ctx.output.stderr(keyValue('Expires', `${standing.expiresAt.toISOString()}${standing.expired ? ' (expired)' : ''}`) + '\n');
      ctx.output.stderr(keyValue('Live', standing.live ? 'yes' : `no: taken in ${standing.spends[0]!.transactionHash}`) + '\n\n');
      return;
    }

    case 'take': {
      const agreed = termsOf(args);
      const taken = await takeSwapOffer(ctx.host, {
        ...paid,
        payer: payerFor('swap take', ctx),
        offer: readOfferText(args),
        agreed,
        now,
        onProgress: (event) => {
          if (event.kind !== 'offer-checked') return showPaidStep(progress, event);
          if (jsonMode) return;
          ctx.output.stderr('\n' + header('Swap: take an offer') + '\n\n');
          ctx.output.stderr(keyValue('Offer', event.id) + '\n');
          ctx.output.stderr(keyValue('You pay', legText(agreed.want)) + '\n');
          ctx.output.stderr(keyValue('You get', legText(agreed.give)) + '\n\n');
        },
      });
      const { txHash, receipt } = taken;
      if (jsonMode) {
        ctx.output.result({ subcommand: 'take', network: taken.network, id: taken.id, txHash, ...(receipt === undefined ? {} : receiptJson(receipt)) });
        return;
      }
      ctx.output.stdout(txHash + '\n');
      if (receipt !== undefined) ctx.output.stderr('\n' + receiptText(receipt, txHash));
      ctx.output.stderr('\n' + dim('  Verify: midnight balance --shielded') + '\n\n');
      return;
    }

    case 'cancel': {
      const id = args.positionals[0];
      if (id === undefined) throw new UsageError('swap cancel needs the offer\'s id (8 characters of it at least): midnight swap cancel <id>');
      const outcome = await cancelSwapOffer(ctx.host, { ...paid, payer: payerFor('swap cancel', ctx), id, onProgress: (event) => showPaidStep(progress, event) });
      // Taken first: nothing to cancel. A failure, as an offer that isn't open is.
      if (outcome.takenIn !== undefined) {
        throw new OfferTakenError(outcome.id, { transactionHash: outcome.takenIn.txHash, blockHeight: outcome.takenIn.blockHeight }, { note: "Nothing was cancelled or sent; mn's record keeps the offer as taken." });
      }
      const { txHash, receipt } = outcome;
      if (jsonMode) {
        ctx.output.result({ subcommand: 'cancel', network: outcome.network, id: outcome.id, cancelled: outcome.cancelled, txHash: txHash ?? null, ...(receipt === undefined ? {} : receiptJson(receipt)) });
        return;
      }
      if (txHash !== undefined) {
        ctx.output.stdout(txHash + '\n');
        if (receipt !== undefined) ctx.output.stderr('\n' + receiptText(receipt, txHash) + '\n');
      }
      return;
    }

    case 'list': {
      const { network, offers } = await listSwapOffers(ctx.host, { ...call, wallet: walletFlag, now, onProgress: (event) => progress.report(event) });
      if (jsonMode) {
        ctx.output.result({
          subcommand: 'list',
          network,
          offers: offers.map(({ offer, expired, taken, takenIn }) => ({ id: offer.id, terms: termsJson(offer.terms), madeAt: offer.madeAt.toISOString(), expiresAt: offer.expiresAt.toISOString(), expired, taken, ...(takenIn === undefined ? {} : { takenIn }) })),
        });
        return;
      }
      ctx.output.stderr('\n' + header('Swap offers') + '\n\n');
      if (offers.length === 0) ctx.output.stderr(dim('  No open offers.') + '\n\n');
      for (const { offer, expired, taken, takenIn } of offers) {
        const status = taken ? `taken${takenIn === undefined ? '' : ` in ${takenIn.txHash}`}` : expired ? 'expired (still takeable on chain until cancelled)' : 'open';
        ctx.output.stderr(keyValue(offer.id.slice(0, 16) + '…', `${legText(offer.terms.give)} for ${legText(offer.terms.want)}, ${status}`) + '\n');
      }
      ctx.output.stderr('\n');
      return;
    }

    default:
      throw new UsageError(`Unknown swap subcommand: ${args.subcommand ?? '(none)'}. Use make, inspect, take, cancel or list.`);
  }
}
