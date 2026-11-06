// What `swap take` asks of its payer: a wallet session whose shielded side is
// synced, on every network (a swap spends shielded coins only, and stagenet
// skips the shielded sync by default). Nothing reaches a chain: the payer is
// the program's own and opens no wallet.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, encodeOfferEnvelope, type ConnectOptions, type Payer } from '@kuiralabs/midnight-cli-core';
import { swapDefinition } from '@kuiralabs/midnight-wallet/commands';
import { cliCall } from './helpers/cli-call.ts';
import { OFFER_GIVE, OFFER_WANT, SWAP_OFFER_HEX } from '../../test-support/fixtures/swap-offer.ts';
import { rcEngine } from '../../test-support/rc-engine.ts';

// The handler, as the shell loads it.
const { default: swapCommand } = await swapDefinition.load();

const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];
const TERMS = ['--give', '10', '--give-token', OFFER_GIVE, '--want', '7', '--want-token', OFFER_WANT];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mn-swap-command-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('swap take', () => {
  it('asks its payer for a session with the shielded side synced', async () => {
    const read = rcEngine.ledger.readOffer(SWAP_OFFER_HEX);
    const file = join(dir, 'offer.json');
    writeFileSync(file, encodeOfferEnvelope({ network: 'undeployed', id: read.id, terms: read.terms, expiresAt: new Date(Date.now() + 3_600_000), tx: SWAP_OFFER_HEX }));
    const asked: (ConnectOptions | undefined)[] = [];
    const payer: Payer = {
      assertCanPay: async () => { throw new Error('not used'); },
      serve: async () => { throw new Error('not used'); },
      connect: async (_target, _wallet, _progress, _sdkWarnings, _signal, options) => { asked.push(options); throw new Error('no wallet here'); },
    };
    await expect(cliCall(swapCommand, parseArgs(['swap', 'take', file, ...TERMS, '--network', 'undeployed', ...ENDPOINTS, '--json']), { payer })).rejects.toThrow('no wallet here');
    expect(asked).toEqual([{ shielded: true }]);
  });
});
