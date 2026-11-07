// The `swap` command, described once.

import { type CommandDefinition, type ToolCheckCall, ENDPOINT_PARAMS, NETWORK_PARAM, confirmationTarget, UsageError } from '@kuiralabs/midnight-cli-core';
import { ENGINE_SYNC, LOADS_ENGINE, PAYS, READS_OFFERS, RESOLVES_NETWORK } from '@kuiralabs/midnight-cli-core/commands';
import { READS_CHAIN } from '@kuiralabs/midnight-chain/commands';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OPENS_WALLET } from './wallet.codes.ts';

/** Where `swap make` writes the offer file for these parameters, as an absolute path: `out` from the working directory, else offer-<id>.json there. */
function offerFileTarget(params: Readonly<Record<string, unknown>>): string {
  return typeof params.out === 'string' && params.out !== '' ? resolve(params.out) : join(process.cwd(), 'offer-<id>.json');
}

/** The terms a swap request states, as the maker gives and wants them. */
function describeTerms(params: Readonly<Record<string, unknown>>): string {
  return `${String(params.give)} of token ${String(params['give-token'])} for ${String(params.want)} of token ${String(params['want-token'])}`;
}

/** A take can run: the offer file is one, for this network, with the agreed terms, not expired. */
async function checkTake(call: ToolCheckCall) {
  const { prepareTake } = await import('../lib/swap/request.ts');
  return prepareTake(call.argv(), call.host.paths().stateRoot, call.host, new Date());
}

export const swapDefinition: CommandDefinition = {
  name: 'swap',
  order: 165,
  subcommands: ['make', 'inspect', 'take', 'cancel', 'list'],
  flags: [
    {
      name: 'give',
      takesValue: true,
      subcommands: ['make', 'take'],
      help: ['--give <amount>               The amount the maker gives, in the token\'s smallest unit'],
      agent: { type: 'string', description: 'Amount the maker gives (smallest unit)' },
    },
    {
      name: 'give-token',
      takesValue: true,
      subcommands: ['make', 'take'],
      help: ['--give-token <type>           The shielded token the maker gives (64 hex characters)'],
      agent: { type: 'string', description: 'Shielded token the maker gives (64 hex)' },
    },
    {
      name: 'want',
      takesValue: true,
      subcommands: ['make', 'take'],
      help: ['--want <amount>               The amount the maker wants back, in the token\'s smallest unit'],
      agent: { type: 'string', description: 'Amount the maker wants back (smallest unit)' },
    },
    {
      name: 'want-token',
      takesValue: true,
      subcommands: ['make', 'take'],
      help: ['--want-token <type>           The shielded token the maker wants back (64 hex characters)'],
      agent: { type: 'string', description: 'Shielded token the maker wants back (64 hex)' },
    },
    {
      name: 'expires-in',
      takesValue: true,
      subcommands: ['make'],
      help: ['--expires-in <seconds>        make: how long a taker using mn may take the offer (default: a day)'],
      agent: { type: 'string', description: 'Seconds a taker using mn may take the offer (default a day)' },
    },
    {
      name: 'out',
      takesValue: true,
      subcommands: ['make'],
      help: ['--out <file>                  make: where to write the offer file (default: offer-<id>.json here)'],
      agent: { type: 'string', description: 'Where to write the offer file' },
    },
    {
      name: 'network',
      takesValue: true,
      help: ['--network <name>              Network (default: the selected one)'],
      agent: { ...NETWORK_PARAM, description: 'Network (default: the selected one)' },
    },
    {
      name: 'wallet',
      takesValue: true,
      help: ['--wallet <name|file>          The wallet that makes, takes, cancels or lists'],
      agent: { type: 'string' },
    },
    {
      name: 'verbose',
      takesValue: false,
      help: ['--verbose                     Diagnostic lines on stderr (make, take, cancel)'],
      // Its lines go to stderr, which no agent reads.
      agent: { notForAgents: 'diagnostics for a person at a terminal' },
    },
    {
      name: 'node',
      takesValue: true,
      help: ['--node <url>                  Node RPC endpoint'],
      agent: ENDPOINT_PARAMS.node,
    },
    {
      name: 'indexer-ws',
      takesValue: true,
      help: ['--indexer-ws <url>            Indexer WebSocket endpoint'],
      agent: ENDPOINT_PARAMS['indexer-ws'],
    },
    {
      name: 'proof-server',
      takesValue: true,
      help: ['--proof-server <url>          Proof server endpoint'],
      agent: ENDPOINT_PARAMS['proof-server'],
    },
  ],
  help: {
    description: 'Private swaps of shielded tokens, through offer files (experimental)',
    usage: 'midnight swap <make|inspect|take|cancel|list> [options]',
    flags: [
      'make                          Make an offer: give --give of --give-token for --want of --want-token;',
      '                              writes the offer file to hand the taker. The offer holds one coin worth',
      '                              exactly --give: with none free, this wallet splits one first (a fee in Dust)',
      'inspect <file>                What an offer file offers, whether it is still live, and its expiry',
      'take <file>                   Take an offer at the terms agreed (--give, --give-token, --want,',
      '                              --want-token, as the maker states them); this wallet pays the fee',
      'cancel <id>                   Cancel an open offer: spend its coins back to this wallet (a fee in Dust)',
      'list                          This wallet\'s open offers, and which were taken',
      { flag: 'give' },
      { flag: 'give-token' },
      { flag: 'want' },
      { flag: 'want-token' },
      { flag: 'expires-in' },
      { flag: 'out' },
      { flag: 'wallet' },
      { flag: 'network' },
      { flag: 'node' },
      { flag: 'indexer-ws' },
      { flag: 'proof-server' },
      { flag: 'verbose' },
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight swap make --give 10 --give-token 00…01 --want 7 --want-token 00…02',
      'midnight swap inspect offer-3fa1….json',
      'midnight swap take offer-3fa1….json --give 10 --give-token 00…01 --want 7 --want-token 00…02',
      'midnight swap cancel 3fa1c0de',
      'midnight swap list --json',
    ],
    jsonFields: {
      subcommand: 'The swap subcommand that ran',
      network: 'Network name',
      id: 'The offer\'s id: the sha256 of its transaction (make, inspect)',
      file: 'Where the offer file was written (make)',
      terms: 'What the maker gives and wants back: token and amount (smallest unit) each (make, inspect)',
      expiresAt: 'When a taker using mn stops taking the offer (make, inspect)',
      live: 'Whether none of the offer\'s coins is spent yet (inspect)',
      expired: 'Whether the maker\'s expiry has passed (inspect)',
      txHash: 'The swap\'s transaction identifier (take), or the cancel\'s (cancel; null when the offer was taken already); midnight tx status takes it',
      receipt: 'The transaction once the indexer lists it: blockHeight, blockHash, blockTime, fee (DUST, exact), feeSpecks, result; null when it has not within 60 s (take, and cancel when submitted)',
      receiptMissing: 'Why receipt is null; check later with midnight tx status <txHash>',
      cancelled: 'True: the cancel was submitted (cancel). An offer taken first fails with OFFER_TAKEN instead',
      split: 'The split made first when no free coin was worth exactly the amount given: txHash, and receipt or receiptMissing as above; absent when none was needed (make)',
      offers: 'The wallet\'s open offers, each with whether it is expired or taken (list)',
    },
  },
  intro: { brief: 'Private swaps through offer files', order: 12.5 },
  needsWalletSdk: true,
  shell: { payer: true },
  errors: { codes: [RESOLVES_NETWORK, OPENS_WALLET, LOADS_ENGINE, ENGINE_SYNC, PAYS, READS_OFFERS, READS_CHAIN, 'CHAIN_CLOCK_BEHIND', 'NO_PAYER', 'OFFER_EXPIRED', 'OFFER_TAKEN'] },
  load: () => import('./swap.ts'),
  mcp: {
    tools: [
      {
        name: 'midnight_swap_make',
        description: 'Make a swap offer: the wallet gives one shielded token for another, and the offer file it writes is what to hand the taker (returns pending token). The taker pays the swap\'s fee; with no free coin worth exactly the amount given, the wallet first splits one, for a fee in Dust.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { flag: 'give' },
          { flag: 'give-token' },
          { flag: 'want' },
          { flag: 'want-token' },
          { flag: 'expires-in' },
          { flag: 'out' },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['give', 'give-token', 'want', 'want-token'],
        argv: { subcommand: 'make', flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Offer ${describeTerms(params)} from wallet ${wallet} on ${network}, splitting a coin first (a fee in Dust) when none is worth exactly the amount given; that coin stays committed until the offer is taken. The offer file is written to ${offerFileTarget(params)}`;
          },
          async check(params, call) {
            const { prepareMake } = await import('../lib/swap/request.ts');
            prepareMake(call.argv(), call.host.paths().stateRoot, call.host, new Date());
            // As the command refuses it, before a token is given: an offer file is never written over another.
            const target = offerFileTarget(params);
            if (typeof params.out === 'string' && existsSync(target)) throw new UsageError(`${target} already exists; an offer file is never written over another`);
          },
        },
        order: 40,
      },
      {
        name: 'midnight_swap_inspect',
        description: 'What a swap offer file offers, read from its own bytes, whether it is still live, and its expiry. Spends nothing.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [
          { name: 'file', schema: { type: 'string', description: 'The offer file' } },
          { flag: 'network' },
        ],
        required: ['file'],
        argv: { subcommand: 'inspect', positionals: ['file'], flags: 'rest' },
        order: 41,
      },
      {
        name: 'midnight_swap_take',
        description: 'Take a swap offer at the agreed terms, as the maker states them (returns pending token). Refused before anything is spent when the terms differ, the offer expired, or it was taken. The wallet pays the fee.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'file', schema: { type: 'string', description: 'The offer file' } },
          { flag: 'give' },
          { flag: 'give-token' },
          { flag: 'want' },
          { flag: 'want-token' },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['file', 'give', 'give-token', 'want', 'want-token'],
        argv: { subcommand: 'take', positionals: ['file'], flags: 'rest' },
        confirmation: {
          // The user confirms the offer as its file was read and checked.
          async check(_params, call) {
            const { offer, target } = await checkTake(call);
            const { give, want } = offer.contents.terms;
            const wallet = confirmationTarget(_params).wallet;
            return `Take offer ${offer.envelope.id.slice(0, 16)}… on ${target.network} with wallet ${wallet}: pay ${want.amount} of token ${want.token}, get ${give.amount} of token ${give.token}, and pay the fee`;
          },
        },
        order: 42,
      },
      {
        name: 'midnight_swap_cancel',
        description: 'Cancel an open swap offer of the wallet\'s by spending its coins back to it (returns pending token). Costs a fee in Dust; an offer taken already is only closed.',
        annotations: { destructiveHint: true, openWorldHint: true },
        params: [
          { name: 'id', schema: { type: 'string', description: 'The offer\'s id, or 8 characters of it at least' } },
          { flag: 'wallet' },
          { flag: 'network' },
        ],
        required: ['id'],
        argv: { subcommand: 'cancel', positionals: ['id'], flags: 'rest' },
        confirmation: {
          describe: (params) => {
            const { network, wallet } = confirmationTarget(params);
            return `Cancel swap offer ${String(params.id)} of wallet ${wallet} on ${network}, spending its coins back to the wallet (a fee in Dust)`;
          },
          async check() { /* the offer is found, and found live, by the command itself */ },
        },
        order: 43,
      },
      {
        name: 'midnight_swap_list',
        description: 'The wallet\'s open swap offers, each with whether it expired or was taken.',
        annotations: { readOnlyHint: true, openWorldHint: true },
        params: [{ flag: 'wallet' }, { flag: 'network' }],
        argv: { subcommand: 'list', flags: 'rest' },
        order: 44,
      },
    ],
  },
};
