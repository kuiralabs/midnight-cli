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
import { createHost, type Host, saveCliConfig, type ConnectOptions, type Payer, type PayingTarget, encodeOfferEnvelope, readOpenOffers, recordOpenOffer, type OpenOffer, type WalletSession } from '@kuiralabs/midnight-cli-core';
import { rcEngine, rcKeys } from '../../../../test-support/rc-engine.ts';
import { loadInstalledEngine } from '../../../../test-support/test-host.ts';
import { makeSwapOffer } from '../lib/swap/make.ts';
import { inspectSwapOffer } from '../lib/swap/inspect.ts';
import { takeSwapOffer } from '../lib/swap/take.ts';
import { cancelSwapOffer } from '../lib/swap/cancel.ts';
import { listSwapOffers } from '../lib/swap/list.ts';
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
    await expect(makeSwapOffer(host, { ...on(), terms: TERMS, expiresAt: NOW, payer, wallet: 'nobody' })).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
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
  function sessionPayer(holdsAtFirst: boolean) {
    const calls: string[] = [];
    let holds = holdsAtFirst;
    const unused = async (): Promise<never> => { throw new Error('not used by swap make'); };
    const session: WalletSession = {
      network: 'undeployed',
      addresses: unused,
      balances: unused,
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
    expect(calls).toEqual(['holdsFreeCoin 10', 'splitCoin 10', 'submit split-tx', 'holdsFreeCoin 10', 'makeOffer 10 7', 'close']);
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
});

describe('cancelSwapOffer', () => {
  it('opens the payer\'s wallet with its shielded side synced, for the wallet named', async () => {
    alice();
    const { payer, asked } = programPayer();
    await expect(cancelSwapOffer(host, { ...on(), id: OFFER.id.slice(0, 8), payer, wallet: 'alice' })).rejects.toThrow('no wallet here');
    expect(asked.map(({ wallet, options }) => [wallet, options])).toEqual([['alice', { shielded: true }]]);
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

    expect(listed).toEqual({ network: 'undeployed', offers: [{ offer: live, expired: false, taken: false }, { offer: taken, expired: false, taken: true }] });
    expect(said).toEqual([{ kind: 'start', message: 'Asking the indexer about each open offer...' }, { kind: 'done', message: '2 offers' }]);
    expect(readOpenOffers(root, 'undeployed', ADDRESS).map((o) => o.id)).toEqual([live.id]);
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
