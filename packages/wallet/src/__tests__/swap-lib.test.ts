// makeSwapOffer, inspectSwapOffer, takeSwapOffer, cancelSwapOffer and
// listSwapOffers, called as a program calls them: a host of its own (a
// temporary state root, the engines the CLI ships), plain values in (the
// offer file's text, not its path), typed results and codes out, no argv and
// no call context. The indexer is a stand-in answering the tip query over
// HTTP and the spend check over graphql-transport-ws, as offer-liveness.ts
// asks them; the offer is a real one (fixtures/swap-offer.ts). The payer is
// the program's own: it records what it is asked and opens no wallet, so a
// make, take or cancel stops where its wallet would open; the scratch chain's
// live runs cover them past it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import { asReported, TransactionInvalidatedError, readSettledOffers, SETTLED_OFFER_KEEP_DAYS, createHost, type Host, saveCliConfig, type ConnectOptions, type Payer, type PayingTarget, encodeOfferEnvelope, readOpenOffers, recordOpenOffer, type OpenOffer, type WalletSession } from '@kuiralabs/midnight-cli-core';
import { rcEngine, rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { makeSwapOffer } from '../lib/swap/make.ts';
import { inspectSwapOffer } from '../lib/swap/inspect.ts';
import { takeSwapOffer } from '../lib/swap/take.ts';
import { cancelSwapOffer } from '../lib/swap/cancel.ts';
import { listSwapOffers } from '../lib/swap/list.ts';
import { refusedByNode, spendsAfterRefusal } from '../lib/swap/offers.ts';
import { swapGuidance } from '../commands/swap.guidance.ts';
import { saveWalletConfig } from '../../../../test-support/plain-wallet.ts';
import { OFFER_GIVE, OFFER_WANT, SWAP_OFFER_HEX } from '../../../../test-support/fixtures/swap-offer.ts';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const SEED = 'c4'.repeat(32);
const ADDRESS = rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex')).undeployed;
const TERMS = { give: { token: OFFER_GIVE, amount: 10n }, want: { token: OFFER_WANT, amount: 7n } };
const OFFER = rcEngine.ledger.readOffer(SWAP_OFFER_HEX);
const SPENT_IN = 'cd'.repeat(32);

/** The stand-in indexer: the chain's tip over HTTP, and the spends of the coins it is told are spent over WebSocket, on one port. */
interface OfferIndexer {
  readonly url: string;
  /** The nullifier prefixes each spend check asked about. */
  readonly asked: string[][];
  close(): Promise<void>;
}

async function startOfferIndexer(spent: readonly string[]): Promise<OfferIndexer> {
  const asked: string[][] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { block: { height: 812 } } }));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
    else if (msg.type === 'subscribe') {
      const prefixes = msg.payload.variables.prefixes as string[];
      asked.push(prefixes);
      for (const nullifier of prefixes.filter((n) => spent.includes(n))) {
        ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { shieldedNullifierTransactions: { nullifier, transactionHash: SPENT_IN, blockHeight: 800 } } } }));
      }
      ws.send(JSON.stringify({ id: msg.id, type: 'complete' }));
    }
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/api/v4/graphql/ws`,
    asked,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

let home: string;
let host: Host;
let root: string;
let indexer: OfferIndexer | undefined;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-swap-lib-')));
  root = path.join(home, '.midnight');
  host = createHost({ paths: { stateRoot: root, home }, engineLoader: loadInstalledEngine });
});

afterEach(async () => {
  await indexer?.close();
  indexer = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The network and its endpoints, the indexer the stand-in; nothing else is reached. */
const on = () => ({ network: 'undeployed' as const, indexerWS: indexer?.url ?? 'ws://127.0.0.1:1/api/v4/graphql/ws', node: 'ws://127.0.0.1:1', proofServer: 'http://127.0.0.1:1' });

/** The real offer's file text, for `network`, expiring at `expiresAt`. */
const offerText = (expiresAt = new Date(NOW.getTime() + 60_000), network = 'undeployed') =>
  encodeOfferEnvelope({ network: network as 'undeployed', id: OFFER.id, terms: OFFER.terms, expiresAt, tx: SWAP_OFFER_HEX });

/** mn's wallet `alice` under the host's state root, the active one. */
function alice(): void {
  saveWalletConfig({ seed: SEED, addresses: rcKeys.unshieldedAddresses(Buffer.from(SEED, 'hex')), createdAt: NOW.toISOString() }, path.join(root, 'wallets', 'alice.json'));
  saveCliConfig({ network: 'undeployed', wallet: 'alice' }, root);
}

/** A program's payer whose wallet won't open: it records what it is asked, and what its step said. */
function programPayer() {
  const asked: { target: PayingTarget; wallet: string | undefined; options: ConnectOptions | undefined; signal: AbortSignal | undefined }[] = [];
  const payer: Payer = {
    assertCanPay: async () => { throw new Error('not used'); },
    serve: async () => { throw new Error('not used'); },
    connect: async (target, wallet, progress, _sdkWarnings, signal, options) => {
      asked.push({ target, wallet, options, signal });
      progress.update('Syncing...');
      throw new Error('no wallet here');
    },
  };
  return { payer, asked };
}

const openOffer = (id: string, nullifier: string): OpenOffer => ({ id, terms: TERMS, nullifiers: [nullifier], madeAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000) });

describe('inspectSwapOffer', () => {
  it('reads the offer\'s text and finds it live: its terms as its bytes state them, not expired', async () => {
    indexer = await startOfferIndexer([]);
    const said: unknown[] = [];
    const standing = await inspectSwapOffer(host, { ...on(), offer: offerText(), now: NOW, onProgress: (event) => said.push(event) });
    expect(standing).toEqual({ network: 'undeployed', id: OFFER.id, terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), expired: false, live: true, spends: [] });
    expect(said).toEqual([{ kind: 'start', message: 'Asking the indexer whether it is still live...' }, { kind: 'done', message: 'Live' }]);
    expect(indexer.asked).toEqual([OFFER.nullifiers]);
  });

  it('finds it taken when a coin of its is spent, and expired past its expiry', async () => {
    indexer = await startOfferIndexer([OFFER.nullifiers[0]!]);
    const said: unknown[] = [];
    const standing = await inspectSwapOffer(host, { ...on(), offer: offerText(NOW), now: NOW, onProgress: (event) => said.push(event) });
    expect(standing).toMatchObject({ live: false, expired: true, spends: [{ nullifier: OFFER.nullifiers[0], transactionHash: SPENT_IN, blockHeight: 800 }] });
    expect(said.at(-1)).toEqual({ kind: 'done', message: 'Taken' });
  });

  it('refuses an offer for another network, and text that is not an offer with NOT_AN_OFFER, asking no indexer', async () => {
    indexer = await startOfferIndexer([]);
    await expect(inspectSwapOffer(host, { ...on(), offer: offerText(undefined, 'preview'), now: NOW })).rejects.toThrow('The offer is for preview, not undeployed');
    await expect(inspectSwapOffer(host, { ...on(), offer: '{"not":"an offer"}', now: NOW })).rejects.toMatchObject({ code: 'NOT_AN_OFFER' });
    expect(indexer.asked).toEqual([]);
  });

  it('cancelled already: CancelledError, nothing said and no indexer asked', async () => {
    indexer = await startOfferIndexer([]);
    const said: unknown[] = [];
    await expect(inspectSwapOffer(host, { ...on(), offer: offerText(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said).toEqual([]);
    expect(indexer.asked).toEqual([]);
  });
});

describe('takeSwapOffer', () => {
  it('says the checked offer, then opens the payer\'s wallet with its shielded side synced, with the call\'s wallet and cancellation', async () => {
    const { payer, asked } = programPayer();
    const controller = new AbortController();
    const said: unknown[] = [];
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer, wallet: 'bob', signal: controller.signal, onProgress: (event) => said.push(event) }))
      .rejects.toThrow('no wallet here');
    expect(said).toEqual([
      { kind: 'offer-checked', network: 'undeployed', id: OFFER.id, terms: TERMS },
      { kind: 'start', message: 'Opening the wallet...' },
      { kind: 'update', message: 'Syncing...' },
    ]);
    expect(asked.map(({ wallet, options, signal }) => [wallet, options, signal === controller.signal])).toEqual([['bob', { shielded: true }, true]]);
    expect(asked[0]!.target).toMatchObject({ network: 'undeployed', root });
  });

  it('refuses other terms with TERMS_MISMATCH and an expired offer with OFFER_EXPIRED, before the wallet opens or anything is said', async () => {
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    const onProgress = (event: unknown) => said.push(event);
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: { ...TERMS, want: { token: OFFER_WANT, amount: 8n } }, now: NOW, payer, onProgress })).rejects.toMatchObject({ code: 'TERMS_MISMATCH' });
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(NOW), agreed: TERMS, now: NOW, payer, onProgress })).rejects.toMatchObject({ code: 'OFFER_EXPIRED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  it('refuses the wallet\'s own open offer as INVALID_ARGS, before the wallet opens or anything is said', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, { ...openOffer(OFFER.id, OFFER.nullifiers[0]!), terms: OFFER.terms });
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer, wallet: 'alice', onProgress: (event) => said.push(event) }))
      .rejects.toMatchObject({ code: 'INVALID_ARGS', name: 'OwnOfferError', message: expect.stringContaining('midnight swap cancel') });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  it('cancelled already: CancelledError, and nothing asked of the payer or said', async () => {
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('makeSwapOffer', () => {
  it('says its network, then opens the payer\'s wallet with its shielded side synced', async () => {
    alice();
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, onProgress: (event) => said.push(event) })).rejects.toThrow('no wallet here');
    expect(said.slice(0, 2)).toEqual([{ kind: 'swap-network', network: 'undeployed' }, { kind: 'start', message: 'Opening the wallet...' }]);
    expect(asked.map(({ wallet, options }) => [wallet, options])).toEqual([[undefined, { shielded: true }]]);
  });

  it('refuses a wallet mn has no file for with WALLET_NOT_FOUND, before the payer is asked', async () => {
    const { payer, asked } = programPayer();
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, wallet: 'nobody' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    expect(asked).toEqual([]);
  });

  it('refuses an expiry that is not a date, or not after now, as INVALID_ARGS, before the payer is asked', async () => {
    alice();
    const { payer, asked } = programPayer();
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(Number.NaN), now: NOW, payer })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('not a date') });
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: NOW, now: NOW, payer })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('already passed') });
    expect(asked).toEqual([]);
  });

  it('cancelled already: CancelledError, and nothing asked of the payer or said', async () => {
    alice();
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: NOW, payer, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('makeSwapOffer with a wallet that opens', () => {
  /** A program's payer whose session is its own: it records each call, holds a free coin of exactly the amount from the start when `holdsAtFirst`, otherwise once it has submitted (the split), and makes the real offer. */
  function sessionPayer(holdsAtFirst: boolean, shieldedHeld: bigint = 1_000n) {
    const calls: string[] = [];
    let holds = holdsAtFirst;
    const unused = async (): Promise<never> => { throw new Error('not used by swap make'); };
    const session: WalletSession = {
      network: 'undeployed',
      addresses: unused,
      balances: async () => { calls.push('balances'); return { unshielded: {}, shielded: { [OFFER_GIVE]: shieldedHeld }, dust: 0n }; },
      balanceTransaction: unused,
      swap: unused,
      makeOffer: async (give, want) => { calls.push(`makeOffer ${give.amount} ${want.amount}`); return SWAP_OFFER_HEX; },
      takeOffer: unused,
      cancelOffers: unused,
      holdsFreeCoin: async (leg) => { calls.push(`holdsFreeCoin ${leg.amount}`); return holds; },
      splitCoin: async (leg) => { calls.push(`splitCoin ${leg.amount}`); return 'split-tx'; },
      sign: unused,
      submit: async (tx) => { calls.push(`submit ${tx}`); holds = true; return 'ab'.repeat(32); },
      readTransaction: unused,
      close: async () => { calls.push('close'); },
    };
    const payer: Payer = { assertCanPay: unused, serve: unused, connect: async () => session };
    return { payer, calls };
  }

  it('with no free coin of exactly the amount, splits one first, waits for it, then makes the offer from it', async () => {
    alice();
    const { payer, calls } = sessionPayer(false);
    const said: unknown[] = [];
    const made = await makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, receiptWaitMs: 0, onProgress: (event) => said.push(event) });
    expect(calls).toEqual(['holdsFreeCoin 10', 'balances', 'splitCoin 10', 'submit split-tx', 'holdsFreeCoin 10', 'makeOffer 10 7', 'close']);
    expect(made.split).toEqual({ txHash: 'ab'.repeat(32) });
    expect(made.id).toBe(OFFER.id);
    expect(said).toContainEqual({ kind: 'done', message: 'Coin split' });
    expect(readOpenOffers(root, 'undeployed', ADDRESS).map((o) => o.id)).toEqual([OFFER.id]);
  });

  it('with a free coin of exactly the amount, makes the offer with no split', async () => {
    alice();
    const { payer, calls } = sessionPayer(true);
    const made = await makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, receiptWaitMs: 0 });
    expect(calls).toEqual(['holdsFreeCoin 10', 'makeOffer 10 7', 'close']);
    expect(made.split).toBeUndefined();
  });

  it('holding less of the token than the offer gives, refuses with INSUFFICIENT_BALANCE before any split (not OFFER_COINS_IN_USE: cancelling can\'t help)', async () => {
    alice();
    const { payer, calls } = sessionPayer(false, 9n);
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, receiptWaitMs: 0 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: expect.stringContaining('holds 9') });
    expect(calls).toEqual(['holdsFreeCoin 10', 'balances', 'close']);
    expect(readOpenOffers(root, 'undeployed', ADDRESS)).toEqual([]);
  });

  it('says what the wallet holds against what the offer gives on its log (--verbose)', async () => {
    alice();
    const { payer } = sessionPayer(false, 9n);
    const lines: string[] = [];
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: new Date(NOW.getTime() + 60_000), now: NOW, payer, log: (phase, message) => lines.push(`${phase}: ${message}`) })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(lines).toEqual([`swap: make: wallet holds 9 of ${OFFER_GIVE}, the offer gives 10`]);
  });
});

describe('cancelSwapOffer', () => {
  it('opens the payer\'s wallet with its shielded side synced, for the wallet named', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, { ...openOffer(OFFER.id, OFFER.nullifiers[0]!), terms: OFFER.terms });
    const { payer, asked } = programPayer();
    await expect(cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer, wallet: 'alice' })).rejects.toThrow('no wallet here');
    expect(asked.map(({ wallet, options }) => [wallet, options])).toEqual([['alice', { shielded: true }]]);
  });

  it.each([
    ['an id shorter than 8 characters', 'a1a1', 'at least 8'],
    ['an id that is not hex', 'zz'.repeat(8), 'hex'],
    ['an id no open offer of the wallet\'s has', 'a2'.repeat(8), 'no open offer'],
  ])('refuses %s as INVALID_ARGS before the payer is asked (no wallet sync)', async (_case, id, reason) => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, openOffer('a1'.repeat(32), 'b1'.repeat(32)));
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(cancelSwapOffer(host, { ...on(), id, payer, onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining(reason) });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });

  it('refuses an id that names two open offers as INVALID_ARGS before the payer is asked', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, openOffer('a1'.repeat(16) + 'c1'.repeat(16), 'b1'.repeat(32)));
    recordOpenOffer(root, 'undeployed', ADDRESS, openOffer('a1'.repeat(16) + 'c2'.repeat(16), 'b2'.repeat(32)));
    const { payer, asked } = programPayer();
    await expect(cancelSwapOffer(host, { ...on(), id: 'a1'.repeat(8), payer })).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('names 2 open offers') });
    expect(asked).toEqual([]);
  });

  it('cancelled already: CancelledError, and nothing asked of the payer or said', async () => {
    alice();
    const { payer, asked } = programPayer();
    const said: unknown[] = [];
    await expect(cancelSwapOffer(host, { ...on(), id: OFFER.id, payer, signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(asked).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('listSwapOffers', () => {
  it('lists the wallet\'s open offers, each asked of the indexer; one taken since is listed taken and closed in mn\'s record', async () => {
    alice();
    const live = openOffer('a1'.repeat(32), 'b1'.repeat(32));
    const taken = openOffer('a2'.repeat(32), 'b2'.repeat(32));
    recordOpenOffer(root, 'undeployed', ADDRESS, live);
    recordOpenOffer(root, 'undeployed', ADDRESS, taken);
    indexer = await startOfferIndexer(['b2'.repeat(32)]);
    const said: unknown[] = [];

    const listed = await listSwapOffers(host, { ...on(), now: NOW, onProgress: (event) => said.push(event) });

    expect(listed).toEqual({ network: 'undeployed', offers: [{ offer: live, expired: false, taken: false }, { offer: taken, expired: false, taken: true, takenIn: { txHash: SPENT_IN, blockHeight: 800 } }] });
    expect(said).toEqual([{ kind: 'start', message: 'Asking the indexer about each open offer...' }, { kind: 'done', message: '2 offers' }]);
    expect(readOpenOffers(root, 'undeployed', ADDRESS).map((o) => o.id)).toEqual([live.id]);
  });

  // Regression: list dropped the taken offer from mn's record, so a later cancel said INVALID_ARGS "no open offer".
  it('keeps an offer it found taken in mn\'s record, so a later cancel answers OFFER_TAKEN with the taking transaction, before the wallet opens', async () => {
    alice();
    const taken = openOffer('a2'.repeat(32), 'b2'.repeat(32));
    recordOpenOffer(root, 'undeployed', ADDRESS, taken);
    indexer = await startOfferIndexer(['b2'.repeat(32)]);
    await listSwapOffers(host, { ...on(), now: NOW });
    expect(readSettledOffers(root, 'undeployed', ADDRESS, NOW).map((o) => [o.id, o.settledBy, o.txHash])).toEqual([[taken.id, 'taken', SPENT_IN]]);

    const { payer, asked } = programPayer();
    const err = await cancelSwapOffer(host, { ...on(), id: taken.id.slice(0, 8), payer }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'OFFER_TAKEN', spentIn: { transactionHash: SPENT_IN, blockHeight: 800 } });
    expect(asked).toEqual([]);
  });

  it('lists none for a wallet with no open offers, asking no indexer', async () => {
    alice();
    indexer = await startOfferIndexer([]);
    expect(await listSwapOffers(host, { ...on(), wallet: 'alice' })).toEqual({ network: 'undeployed', offers: [] });
    expect(indexer.asked).toEqual([]);
  });

  it('cancelled already: CancelledError, nothing said and no indexer asked', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, openOffer('a1'.repeat(32), 'b1'.repeat(32)));
    indexer = await startOfferIndexer([]);
    const said: unknown[] = [];
    await expect(listSwapOffers(host, { ...on(), signal: AbortSignal.abort(), onProgress: (event) => said.push(event) })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(said).toEqual([]);
    expect(indexer.asked).toEqual([]);
  });
});

// Two wallets racing on one offer: the node refuses the loser's transaction
// for spending the offer's coin a second time (ledger 9's Zswap
// NullifierAlreadyPresent, "Custom error: 239").
describe('losing a race for an offer', () => {
  /** The node's refusal as the connector forwards it. */
  const refusal = () => new Error('Transaction submission failed: Transaction submission error: 1010: Invalid Transaction: Custom error: 239');

  /** A payer whose session builds the take and the cancel, and whose submit the node refuses once another transaction spent the offer's coin. */
  function racingPayer(spent: string[], refuse: () => Error = refusal) {
    const unused = async (): Promise<never> => { throw new Error('not used'); };
    const session: WalletSession = {
      network: 'undeployed', addresses: unused, balanceTransaction: unused, swap: unused, makeOffer: unused,
      // Enough of what the offer wants.
      balances: async () => ({ unshielded: {}, shielded: { [OFFER.terms.want.token]: OFFER.terms.want.amount }, dust: 0n }),
      takeOffer: async () => 'swap-tx',
      cancelOffers: async () => 'cancel-tx',
      holdsFreeCoin: unused, splitCoin: unused, sign: unused, readTransaction: unused,
      // The other transaction lands first: its spend is on chain when the node refuses this one.
      submit: async () => { spent.push(OFFER.nullifiers[0]!); throw refuse(); },
      close: async () => {},
    };
    const payer: Payer = { assertCanPay: unused, serve: unused, connect: async () => session };
    return payer;
  }

  // Regression: the taker got the node's raw "TX_REJECTED 1010 … Custom error: 239".
  it('a take refused because the offer was taken or cancelled first fails with OFFER_TAKEN, naming the transaction that spent it', async () => {
    const spent: string[] = [];
    indexer = await startOfferIndexer(spent);
    const err = await takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer: racingPayer(spent), receiptWaitMs: 0 }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'OFFER_TAKEN', name: 'OfferTakenError', spentIn: { transactionHash: SPENT_IN, blockHeight: 800 } });
    expect((err as Error).message).toContain(`spent in transaction ${SPENT_IN} (block 800). It was taken, or its maker cancelled it, first.`);
    expect((err as Error).message).toContain('The node refused this swap for it.');
    // Reported as itself: a node's refusal among its causes would be reported in its place.
    expect(asReported(err as Error)).toBe(err);
  });

  it('a take refused for anything else keeps the node\'s refusal', async () => {
    const spent: string[] = [];
    indexer = await startOfferIndexer(spent);
    const other = () => new Error('Transaction submission failed: 1010: Invalid Transaction: Custom error: 170');
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer: racingPayer(spent, other), receiptWaitMs: 0 }))
      .rejects.toThrow('Custom error: 170');
  });

  // Regression: a cancel that lost the race to a taker failed with the node's raw refusal.
  it('a cancel refused because the offer was taken first is no cancel: the reason and the taking transaction, mn\'s record closed', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, { ...openOffer(OFFER.id, OFFER.nullifiers[0]!), terms: OFFER.terms });
    const spent: string[] = [];
    indexer = await startOfferIndexer(spent);
    const outcome = await cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer: racingPayer(spent), receiptWaitMs: 0 });
    expect(outcome).toEqual({ network: 'undeployed', id: OFFER.id, cancelled: false, reason: 'taken', takenIn: { txHash: SPENT_IN, blockHeight: 800 } });
    expect(readOpenOffers(root, 'undeployed', ADDRESS)).toEqual([]);
  });

  it('a cancel of an offer the indexer already lists as taken sends nothing, and says so the same way', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, { ...openOffer(OFFER.id, OFFER.nullifiers[0]!), terms: OFFER.terms });
    const spent = [OFFER.nullifiers[0]!];
    indexer = await startOfferIndexer(spent);
    const outcome = await cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer: racingPayer([]), receiptWaitMs: 0 });
    expect(outcome).toEqual({ network: 'undeployed', id: OFFER.id, cancelled: false, reason: 'taken', takenIn: { txHash: SPENT_IN, blockHeight: 800 } });
    expect(readOpenOffers(root, 'undeployed', ADDRESS)).toEqual([]);
  });

  // As the live race on the local chain reported the loser: in the pool, then invalid once the other landed.
  const invalidInPool = () => Object.assign(new Error('The node refused the transaction: Transaction is invalid and was rejected by the node'), { code: 'TX_REJECTED' });

  it('a take refused as invalid once the other transaction landed fails with OFFER_TAKEN too', async () => {
    const spent: string[] = [];
    indexer = await startOfferIndexer(spent);
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer: racingPayer(spent, invalidInPool), receiptWaitMs: 0 }))
      .rejects.toMatchObject({ code: 'OFFER_TAKEN', spentIn: { transactionHash: SPENT_IN, blockHeight: 800 } });
  });

  // Regression: two takes at once; the loser, dropped from the node's pool once the winner landed, failed TX_INVALIDATED (exit 6) with a message about the same wallet's transactions.
  it('a take dropped from the pool as invalid (TX_INVALIDATED) once another taker landed fails with OFFER_TAKEN', async () => {
    const spent: string[] = [];
    indexer = await startOfferIndexer(spent);
    const err = await takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer: racingPayer(spent, () => new TransactionInvalidatedError(0)), receiptWaitMs: 0 }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'OFFER_TAKEN', spentIn: { transactionHash: SPENT_IN, blockHeight: 800 } });
    expect(asReported(err as Error)).toBe(err);
  });

  it('a cancel of an offer this wallet cancelled already says so, naming the cancel, before the wallet opens', async () => {
    alice();
    recordOpenOffer(root, 'undeployed', ADDRESS, { ...openOffer(OFFER.id, OFFER.nullifiers[0]!), terms: OFFER.terms });
    indexer = await startOfferIndexer([]);
    const spent: string[] = [];
    const cancelOnce: WalletSession['submit'] = async () => 'ef'.repeat(32);
    const unused = async (): Promise<never> => { throw new Error('not used'); };
    const session = { network: 'undeployed', cancelOffers: async () => 'cancel-tx', submit: cancelOnce, close: async () => {}, addresses: unused, balanceTransaction: unused, swap: unused, makeOffer: unused, balances: unused, takeOffer: unused, holdsFreeCoin: unused, splitCoin: unused, sign: unused, readTransaction: unused } as WalletSession;
    const first = await cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer: { assertCanPay: unused, serve: unused, connect: async () => session }, receiptWaitMs: 0 });
    expect(first).toMatchObject({ cancelled: true, txHash: 'ef'.repeat(32) });
    void spent;

    const { payer, asked } = programPayer();
    const err = await cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'INVALID_ARGS' });
    expect((err as Error).message).toContain(`was cancelled already, in transaction ${'ef'.repeat(32)}`);
    expect(asked).toEqual([]);
  });

  it('reads a node\'s refusal in the error or any of its causes, and nothing else', () => {
    expect(refusedByNode(refusal())).toBe(true);
    expect(refusedByNode(new Error('wrapped', { cause: refusal() }))).toBe(true);
    expect(refusedByNode(invalidInPool())).toBe(true);
    expect(refusedByNode(Object.assign(new Error('stale'), { code: 'STALE_UTXO' }))).toBe(true);
    expect(refusedByNode(new Error('1010: Invalid Transaction: Custom error: 2390'))).toBe(false);
    expect(refusedByNode(Object.assign(new Error('proof'), { code: 'PROOF_FAILURE' }))).toBe(false);
    expect(refusedByNode('Custom error: 239')).toBe(false);
  });

  it('finds no spend when the coin the node found spent is not the offer\'s, after its wait', async () => {
    indexer = await startOfferIndexer([]);
    const endpoints = { indexer: indexer.url.replace(/^ws/, 'http').replace(/\/ws$/, ''), indexerWS: indexer.url };
    expect(await spendsAfterRefusal(refusal(), endpoints, OFFER.nullifiers, undefined, 0)).toEqual([]);
    expect(indexer.asked).toHaveLength(1);
  });
});

describe('taking with less than the offer wants', () => {
  // Regression: the take was built and proved, then failed with the SDK's "Insufficient funds", naming nothing.
  it('refuses with INSUFFICIENT_BALANCE, naming the token and both amounts, before the take is built', async () => {
    indexer = await startOfferIndexer([]);
    const calls: string[] = [];
    const unused = async (): Promise<never> => { throw new Error('not used'); };
    const want = OFFER.terms.want;
    const session: WalletSession = {
      network: 'undeployed', addresses: unused, balanceTransaction: unused, swap: unused, makeOffer: unused, cancelOffers: unused,
      holdsFreeCoin: unused, splitCoin: unused, sign: unused, readTransaction: unused, submit: unused,
      balances: async () => ({ unshielded: {}, shielded: { [want.token.toUpperCase()]: want.amount - 1n, ['ff'.repeat(32)]: 1_000n }, dust: 0n }),
      takeOffer: async () => { calls.push('takeOffer'); return 'swap-tx'; },
      close: async () => {},
    };
    const payer: Payer = { assertCanPay: unused, serve: unused, connect: async () => session };
    await expect(takeSwapOffer(host, { ...on(), offer: offerText(), agreed: TERMS, now: NOW, payer, receiptWaitMs: 0 }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', message: `The wallet holds ${want.amount - 1n} of the shielded token ${want.token}, and the offer wants ${want.amount}: it is short by 1. Receive more of it first.` });
    expect(calls).toEqual([]);
  });
});

describe('the swap guidance', () => {
  it('says how long mn keeps an offer it saw taken or cancelled, as mn keeps it', () => {
    const text = (swapGuidance.pieces ?? []).map((piece) => piece.body).join('\n');
    expect(text).toContain(`saw taken or cancelled for ${SETTLED_OFFER_KEEP_DAYS} days`);
  });
});

