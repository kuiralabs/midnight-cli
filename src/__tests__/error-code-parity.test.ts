// What each typed error, thrown where mn throws it, reports: its code and the
// exit code it ends the CLI with. Each row records the classification without
// the registry (what mn reported before codes were owned per package) and with
// the installed registry (what the shell and the MCP server report now). They
// differ only where the owner approved it (Y52): NO_STATE_ROOT, NO_PAYER and
// NO_NODE_RUNTIME by name instead of UNKNOWN, an escaped stale cache as
// STALE_CACHE, and a failed command run through MCP as COMMAND_FAILED.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { CancelledError, CommandFailedError, TransactionRefusedError, UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { createHost } from '@kuiralabs/midnight-cli-core/lib/host';
import { payerFor } from '@kuiralabs/midnight-cli-core/lib/payer';
import { openSecret, sealSecret } from '@kuiralabs/midnight-cli-core/lib/keystore';
import { checkTerms, NotAnOfferError } from '@kuiralabs/midnight-cli-core/lib/swap-offer';
import { assertOfferUnexpired } from '@kuiralabs/midnight-cli-core/lib/offer-envelope';
import { OfferCoinsInUseError } from '@kuiralabs/midnight-cli-core/lib/open-offers';
import { AmbiguousLocalStacksError } from '@kuiralabs/midnight-cli-core/lib/network';
import {
  BlockfrostLimitError,
  BlockfrostProjectIdRejectedError,
  BlockfrostProjectIdRequiredError,
  EndpointShutDownError,
} from '@kuiralabs/midnight-cli-core/lib/blockfrost';
import { MixedSdkLayoutError } from '@kuiralabs/midnight-cli-core/lib/sdk-layout';
import { OtherSdkSetError } from '@kuiralabs/midnight-cli-core/lib/engine';
import { DustFeeNotGeneratedError, planRegistration } from '@kuiralabs/midnight-cli-core/lib/dust-registration-plan';
import { LocalStackUnreachableError, UnsupportedLedgerError } from '@kuiralabs/midnight-chain/lib/ledger-guard';
import { ChainClockBehindError } from '@kuiralabs/midnight-chain/lib/chain-clock';
import { StaleCacheError } from '@kuiralabs/midnight-engine-rc/facade';
import { readPassphrase } from '../lib/passphrase.ts';
import { assertWalletFileExists, setActiveWallet } from '../lib/wallet-config.ts';
import { UnsupportedNodeError } from '../lib/node-version.ts';
import { LocalnetUnavailableError } from '../lib/localnet.ts';
import { scriptRuntime } from '../lib/contract/runner.ts';
import { NoSuchOfferError } from '../lib/swap/offers.ts';
import { NoAccountError } from '../lib/grant/prepare.ts';
import { NodeTooOldForAccountError, UnreachableByAccountError } from '../lib/grant/account.ts';
import { installedCommands } from '../lib/installed-commands.ts';

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'mn-code-parity-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** What the function throws; fails the test when it throws nothing. */
async function thrownBy(run: () => unknown): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected it to throw');
}

const A = '0'.repeat(64);
const B = '1'.repeat(64);
const AGREED = { give: { token: A, amount: 10n }, want: { token: B, amount: 7n } };
const TWENTY_NIGHT = { dust: { generatedNow: 337_954_960_000_000n, rate: 165_340_000_000n, maxCap: 100_000_000_000_000_000n } };

type Classified = { errorCode: string; exitCode: number };
const as = (errorCode: string, exitCode: number): Classified => ({ errorCode, exitCode });

/** [where it is thrown, how to throw it, without the registry, with it]. */
const ROWS: [string, () => unknown, Classified, Classified][] = [
  // The caller's to fix: exit 2.
  ['a usage error', () => { throw new UsageError('Missing required flag: --to'); }, as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['no passphrase to be had', () => readPassphrase(null, { env: {} }), as('PASSPHRASE_REQUIRED', 2), as('PASSPHRASE_REQUIRED', 2)],
  ['a wrong passphrase', () => openSecret(sealSecret(Buffer.from('secret'), 'the right passphrase', 'wallet'), 'a wrong passphrase', 'wallet'), as('WRONG_PASSPHRASE', 2), as('WRONG_PASSPHRASE', 2)],
  ['bytes that are no offer', () => { throw new NotAnOfferError('it is not hex'); }, as('NOT_AN_OFFER', 2), as('NOT_AN_OFFER', 2)],
  ['an offer on other terms', () => checkTerms({ give: AGREED.want, want: AGREED.give }, AGREED), as('TERMS_MISMATCH', 2), as('TERMS_MISMATCH', 2)],
  ['an expired offer', () => assertOfferUnexpired({ network: 'undeployed', id: 'ab', terms: AGREED, expiresAt: new Date(0), tx: '' }, new Date(1)), as('OFFER_EXPIRED', 2), as('OFFER_EXPIRED', 2)],
  ['coins an open offer holds', () => { throw new OfferCoinsInUseError(['ab'.repeat(32)]); }, as('OFFER_COINS_IN_USE', 2), as('OFFER_COINS_IN_USE', 2)],
  ['no such open offer (a usage error)', () => { throw new NoSuchOfferError('ab'); }, as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['an account unreachable on this set (a usage error)', () => { throw new UnreachableByAccountError('undeployed'); }, as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],

  // No such wallet: exit 3, by its message.
  ['no wallet of that name', () => setActiveWallet(root, 'nobody'), as('WALLET_NOT_FOUND', 3), as('WALLET_NOT_FOUND', 3)],
  ['no wallet file', () => assertWalletFileExists(join(root, 'wallets', 'nobody.json')), as('WALLET_NOT_FOUND', 3), as('WALLET_NOT_FOUND', 3)],

  // Setup and network: exit 4.
  ['several local stacks', () => { throw new AmbiguousLocalStacksError({ node: [9944, 9945], indexer: [8088], proofServer: [6300] }); }, as('AMBIGUOUS_LOCAL_STACKS', 4), as('AMBIGUOUS_LOCAL_STACKS', 4)],
  ['no Blockfrost project id', () => { throw new BlockfrostProjectIdRequiredError('preprod'); }, as('BLOCKFROST_PROJECT_ID_REQUIRED', 4), as('BLOCKFROST_PROJECT_ID_REQUIRED', 4)],
  ['a refused Blockfrost project id', () => { throw new BlockfrostProjectIdRejectedError('preprod'); }, as('BLOCKFROST_PROJECT_ID_REJECTED', 4), as('BLOCKFROST_PROJECT_ID_REJECTED', 4)],
  ["Blockfrost's limit", () => { throw new BlockfrostLimitError(429); }, as('BLOCKFROST_LIMIT_REACHED', 4), as('BLOCKFROST_LIMIT_REACHED', 4)],
  ['an endpoint shut down', () => { throw new EndpointShutDownError('wss://indexer.example/api/v3/graphql/ws'); }, as('ENDPOINT_SHUT_DOWN', 4), as('ENDPOINT_SHUT_DOWN', 4)],
  ['a ledger-8 chain', () => { throw new UnsupportedLedgerError('preprod', 8_000_000n); }, as('UNSUPPORTED_LEDGER', 4), as('UNSUPPORTED_LEDGER', 4)],
  ['no stack at the endpoints', () => { throw new LocalStackUnreachableError('node', 'ws://127.0.0.1:1'); }, as('LOCAL_STACK_UNREACHABLE', 4), as('LOCAL_STACK_UNREACHABLE', 4)],
  ["the chain's clock behind", () => { throw new ChainClockBehindError(new Date(0), new Date(3_600_000)); }, as('CHAIN_CLOCK_BEHIND', 4), as('CHAIN_CLOCK_BEHIND', 4)],
  ['localnet up refused', () => { throw new LocalnetUnavailableError(); }, as('LOCALNET_UNAVAILABLE', 4), as('LOCALNET_UNAVAILABLE', 4)],

  // Balance: exit 5.
  ['a Dust fee not generated yet', () => { throw new DustFeeNotGeneratedError(planRegistration(526_587_115_818_352n, [TWENTY_NIGHT]), new Date('2026-10-05T04:05:23.000Z')); }, as('DUST_GENERATING', 5), as('DUST_GENERATING', 5)],

  // Refused transactions and stale state: exit 6.
  ["the node's refusal", () => { throw new TransactionRefusedError('Invalid transaction'); }, as('TX_REJECTED', 6), as('TX_REJECTED', 6)],
  ['a stale cache that escapes (approved: was UNKNOWN)', () => { throw new StaleCacheError('applied 120 of 80 events'); }, as('UNKNOWN', 1), as('STALE_CACHE', 6)],

  // Cancelled: exit 7.
  ['a cancelled call', () => { throw new CancelledError(); }, as('CANCELLED', 7), as('CANCELLED', 7)],

  // General: exit 1.
  ['an old Node.js', () => { throw new UnsupportedNodeError('20.10.0'); }, as('UNSUPPORTED_NODE', 1), as('UNSUPPORTED_NODE', 1)],
  ['an old Node.js for the account', () => { throw new NodeTooOldForAccountError('22.0.0'); }, as('UNSUPPORTED_NODE', 1), as('UNSUPPORTED_NODE', 1)],
  ['two copies of a ledger', () => { throw new MixedSdkLayoutError('rc', '@midnight-ntwrk/ledger-v8', ['a', 'b']); }, as('MIXED_SDK_LAYOUT', 1), as('MIXED_SDK_LAYOUT', 1)],
  ['the other SDK set', () => { throw new OtherSdkSetError('rc', 'beta'); }, as('OTHER_SDK_SET', 1), as('OTHER_SDK_SET', 1)],
  ['no account', () => { throw new NoAccountError('alice', 'undeployed'); }, as('NO_ACCOUNT', 1), as('NO_ACCOUNT', 1)],
  ['no state root (approved: was UNKNOWN)', () => createHost().paths(), as('UNKNOWN', 1), as('NO_STATE_ROOT', 1)],
  ['no payer (approved: was UNKNOWN)', () => payerFor('transfer', undefined), as('UNKNOWN', 1), as('NO_PAYER', 1)],
  ['no Node.js for a contract script (approved: was UNKNOWN)', () => scriptRuntime({ execPath: '/opt/bun/bin/bun', isNode: false }, ''), as('UNKNOWN', 1), as('NO_NODE_RUNTIME', 1)],
  // Without the registry its code came from its result's text: here, words that read as a network error.
  ['a failed command (approved: was by its text)', () => { throw new CommandFailedError('test run', 1, { overall: 'fail', error: 'network error' }); }, as('NETWORK_ERROR', 4), as('COMMAND_FAILED', 1)],
  ['an error no rule knows', () => { throw new Error('Something unexpected happened'); }, as('UNKNOWN', 1), as('UNKNOWN', 1)],
];

describe('the code and exit code of each typed error', () => {
  it.each(ROWS)('%s', async (_where, run, before, now) => {
    const err = await thrownBy(run);
    expect(classifyError(err)).toStrictEqual(before);
    expect(classifyError(err, installedCommands)).toStrictEqual(now);
  });
});
