// swap command — private swaps of shielded tokens through offer files
// Usage: midnight swap <make|inspect|take|cancel|list> [options]
//
// The maker's and the taker's wallets each run in this process, through the
// payer's wallet session: no server, no port. inspect and list open no wallet.

import { existsSync, writeFileSync } from 'node:fs';
import { type ParsedArgs, hasFlag, getFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { payerFor, resolvePayingTarget } from '@kuiralabs/midnight-cli-core/lib/payer';
import type { CallContext } from '@kuiralabs/midnight-cli-core/lib/call-context';
import type { SwapLeg, SwapTerms } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { header, keyValue } from '@kuiralabs/midnight-cli-core/ui/format';
import { dim } from '@kuiralabs/midnight-cli-core/ui/colors';
import type { Spinner } from '@kuiralabs/midnight-cli-core/ui/spinner';
import { resolveWalletPath, walletAddress } from '../lib/wallet-config.ts';
import { cancelOffer, listOffers, makeOffer, standingOf, takeOffer } from '../lib/swap/offers.ts';
import { prepareMake, prepareTake, readOfferArg } from '../lib/swap/request.ts';

const legJson = ({ token, amount }: SwapLeg) => ({ token, amount: amount.toString() });
const termsJson = ({ give, want }: SwapTerms) => ({ give: legJson(give), want: legJson(want) });
const legText = ({ token, amount }: SwapLeg) => `${amount} of ${token}`;

export default async function swapCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const spinnerFor = (label: string): Spinner => (jsonMode ? ctx.progress.silent() : ctx.progress.start(label));
  const walletFlag = getFlag(args, 'wallet');
  const now = new Date();

  switch (args.subcommand) {
    case 'make': {
      const { target, terms, expiresAt, out } = prepareMake(args, now);
      if (out !== undefined && existsSync(out)) throw new UsageError(`${out} already exists; an offer file is never written over another`);
      if (!jsonMode) {
        ctx.output.stderr('\n' + header('Swap: make an offer') + '\n\n');
        ctx.output.stderr(keyValue('Network', target.network) + '\n');
        ctx.output.stderr(keyValue('Gives', legText(terms.give)) + '\n');
        ctx.output.stderr(keyValue('Wants', legText(terms.want)) + '\n\n');
      }
      const address = await walletAddress(resolveWalletPath(walletFlag), target.network);
      const session = await payerFor('swap make', ctx).connect(target, walletFlag, spinnerFor('Opening the wallet...'), ctx.sdkWarnings, ctx.signal);
      try {
        const spinner = spinnerFor('Making the offer (proving its half)...');
        const made = await makeOffer(session, address, terms, expiresAt, now);
        const file = out ?? `offer-${made.envelope.id.slice(0, 16)}.json`;
        writeFileSync(file, made.file, { flag: 'wx' });
        spinner.stop('Offer made');
        if (jsonMode) {
          ctx.output.result({ subcommand: 'make', network: target.network, id: made.envelope.id, file, terms: termsJson(made.envelope.terms), expiresAt: expiresAt.toISOString() });
          return;
        }
        ctx.output.stdout(file + '\n');
        ctx.output.stderr('\n' + keyValue('Offer', made.envelope.id) + '\n');
        ctx.output.stderr(keyValue('File', file) + '\n');
        ctx.output.stderr(keyValue('Expires', expiresAt.toISOString()) + '\n');
        ctx.output.stderr('\n' + dim('  Hand the file to the taker. Its coins stay committed until it is taken.') + '\n\n');
      } finally {
        await session.close();
      }
      return;
    }

    case 'inspect': {
      const target = resolvePayingTarget(args, 'swap', 'inspect');
      const offer = await readOfferArg(args, target);
      const spinner = spinnerFor('Asking the indexer whether it is still live...');
      const { expired, spends } = await standingOf(offer, target.networkConfig, now, ctx.signal);
      spinner.stop(spends.length === 0 ? 'Live' : 'Taken');
      const { envelope } = offer;
      if (jsonMode) {
        ctx.output.result({ subcommand: 'inspect', network: target.network, id: envelope.id, terms: termsJson(envelope.terms), expiresAt: envelope.expiresAt.toISOString(), live: spends.length === 0, expired });
        return;
      }
      ctx.output.stderr('\n' + header('Swap offer') + '\n\n');
      ctx.output.stderr(keyValue('Offer', envelope.id) + '\n');
      ctx.output.stderr(keyValue('Network', envelope.network) + '\n');
      ctx.output.stderr(keyValue('Maker gives', legText(envelope.terms.give)) + '\n');
      ctx.output.stderr(keyValue('Maker wants', legText(envelope.terms.want)) + '\n');
      ctx.output.stderr(keyValue('Expires', `${envelope.expiresAt.toISOString()}${expired ? ' (expired)' : ''}`) + '\n');
      ctx.output.stderr(keyValue('Live', spends.length === 0 ? 'yes' : `no: taken in ${spends[0]!.transactionHash}`) + '\n\n');
      return;
    }

    case 'take': {
      const { target, offer, agreed } = await prepareTake(args, now);
      if (!jsonMode) {
        ctx.output.stderr('\n' + header('Swap: take an offer') + '\n\n');
        ctx.output.stderr(keyValue('Offer', offer.envelope.id) + '\n');
        ctx.output.stderr(keyValue('You pay', legText(agreed.want)) + '\n');
        ctx.output.stderr(keyValue('You get', legText(agreed.give)) + '\n\n');
      }
      const session = await payerFor('swap take', ctx).connect(target, walletFlag, spinnerFor('Opening the wallet...'), ctx.sdkWarnings, ctx.signal);
      try {
        const spinner = spinnerFor('Checking the offer, adding this half and proving the swap...');
        const txHash = await takeOffer(session, offer, agreed, target.networkConfig, now, ctx.signal);
        spinner.stop('Swap submitted');
        if (jsonMode) {
          ctx.output.result({ subcommand: 'take', network: target.network, id: offer.envelope.id, txHash });
          return;
        }
        ctx.output.stdout(txHash + '\n');
        ctx.output.stderr('\n' + dim('  Verify: midnight balance --shielded') + '\n\n');
      } finally {
        await session.close();
      }
      return;
    }

    case 'cancel': {
      const id = args.positionals[0];
      if (id === undefined) throw new UsageError('swap cancel needs the offer\'s id (8 characters of it at least): midnight swap cancel <id>');
      const target = resolvePayingTarget(args, 'swap', 'cancel');
      const address = await walletAddress(resolveWalletPath(walletFlag), target.network);
      const session = await payerFor('swap cancel', ctx).connect(target, walletFlag, spinnerFor('Opening the wallet...'), ctx.sdkWarnings, ctx.signal);
      try {
        const spinner = spinnerFor('Spending the offer\'s coins back to this wallet...');
        const outcome = await cancelOffer(session, target.networkConfig, address, id, ctx.signal);
        spinner.stop(outcome.txHash === undefined ? 'It was taken already' : 'Offer cancelled');
        const offer = [...outcome.cancelled, ...outcome.alreadyTaken][0]!;
        if (jsonMode) {
          ctx.output.result({ subcommand: 'cancel', network: target.network, id: offer.id, cancelled: outcome.txHash !== undefined, txHash: outcome.txHash ?? null });
          return;
        }
        if (outcome.txHash !== undefined) ctx.output.stdout(outcome.txHash + '\n');
        else ctx.output.stderr('\n' + dim(`  ${offer.id.slice(0, 16)}… was taken before it could be cancelled; it is closed.`) + '\n\n');
      } finally {
        await session.close();
      }
      return;
    }

    case 'list': {
      const target = resolvePayingTarget(args, 'swap', 'list');
      const address = await walletAddress(resolveWalletPath(walletFlag), target.network);
      const spinner = spinnerFor('Asking the indexer about each open offer...');
      const listed = await listOffers(target.network, target.networkConfig, address, now, ctx.signal);
      spinner.stop(`${listed.length} offer${listed.length === 1 ? '' : 's'}`);
      if (jsonMode) {
        ctx.output.result({
          subcommand: 'list',
          network: target.network,
          offers: listed.map(({ offer, expired, taken }) => ({ id: offer.id, terms: termsJson(offer.terms), madeAt: offer.madeAt.toISOString(), expiresAt: offer.expiresAt.toISOString(), expired, taken })),
        });
        return;
      }
      ctx.output.stderr('\n' + header('Swap offers') + '\n\n');
      if (listed.length === 0) ctx.output.stderr(dim('  No open offers.') + '\n\n');
      for (const { offer, expired, taken } of listed) {
        const status = taken ? 'taken' : expired ? 'expired (still takeable on chain until cancelled)' : 'open';
        ctx.output.stderr(keyValue(offer.id.slice(0, 16) + '…', `${legText(offer.terms.give)} for ${legText(offer.terms.want)}, ${status}`) + '\n');
      }
      ctx.output.stderr('\n');
      return;
    }

    default:
      throw new UsageError(`Unknown swap subcommand: ${args.subcommand ?? '(none)'}. Use make, inspect, take, cancel or list.`);
  }
}
