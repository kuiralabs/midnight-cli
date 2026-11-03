// What each typed error, thrown where mn throws it, reports: its code and the
// exit code it ends the CLI with. Each row records the classification without
// the registry (what mn reported before codes were owned per package) and with
// the installed registry (what the shell and the MCP server report now). They
// differ only where the owner approved it (Y52): NO_STATE_ROOT, NO_PAYER and
// NO_NODE_RUNTIME by name instead of UNKNOWN, an escaped stale cache as
// STALE_CACHE, and a failed command run through MCP as COMMAND_FAILED; and
// (Y53) a wallet with no NIGHT as INSUFFICIENT_BALANCE and an unreachable
// indexer as NETWORK_ERROR, whatever their messages say. A third
// classification reads the error's code alone, with no message rule: what the
// shell and the MCP server report once the rules are gone.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyByCode, classifyError } from '@kuiralabs/midnight-cli-core/lib/exit-codes';
import { CancelledError, CommandFailedError, DustRequiredError, InsufficientBalanceError, TransactionRefusedError, UsageError } from '@kuiralabs/midnight-cli-core/lib/errors';
import { parseArgs, requireFlag } from '@kuiralabs/midnight-cli-core/lib/argv';
import { dustShortError } from '@kuiralabs/midnight-cli-core/lib/dust-wait';
import { ProgramTimedOutError } from '@kuiralabs/midnight-cli-core/lib/exec-program';
import { NATIVE_TOKEN_TYPE } from '@kuiralabs/midnight-cli-core/lib/constants';
import type { NetworkConfig } from '@kuiralabs/midnight-cli-core/lib/network';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui/spinner';
import type { CommandHandler } from '@kuiralabs/midnight-cli-core/lib/call-context';
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
import { waitForFirstBlock } from '@kuiralabs/midnight-chain/lib/node-ready';
import { waitForAddressFunded } from '@kuiralabs/midnight-chain/lib/indexer-ready';
import { waitForProofServerReady } from '@kuiralabs/midnight-chain/lib/proof-server-ready';
import { callNodeRpc } from '@kuiralabs/midnight-chain/lib/node-rpc';
import { subscribeGraphqlWs } from '@kuiralabs/midnight-chain/lib/graphql-ws-subscription';
import { checkBalance } from '@kuiralabs/midnight-chain/lib/balance-subscription';
import { queryIndexer } from '@kuiralabs/midnight-chain/lib/indexer-graphql';
import { StaleCacheError } from '@kuiralabs/midnight-engine-rc/facade';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '@kuiralabs/midnight-engine-rc/derive-address';
import * as ledger from '@midnightntwrk/ledger-v9';
import { readPassphrase } from '../lib/passphrase.ts';
import { assertWalletFileExists, assertWalletRemovable, setActiveWallet } from '../lib/wallet-config.ts';
import { walletSecretFrom } from '../lib/wallet-create.ts';
import { resolveTransferRequest } from '../lib/transfer-request.ts';
import { assertWalletCanPay } from '../lib/wallet-can-pay.ts';
import { PrepStepFailedError, runPrepSteps } from '../lib/test/prep-runner.ts';
import { createPrepContext, type DappTestConfig } from '../lib/test/types.ts';
import { createSdkWarningRouter } from '@kuiralabs/midnight-cli-core/lib/sdk-warnings';
import { loadInstalledEngine } from '../lib/installed-engines.ts';
import walletCommand from '../commands/wallet.ts';
import generateCommand from '../commands/generate.ts';
import addressCommand from '../commands/address.ts';
import airdropCommand from '../commands/airdrop.ts';
import balanceCommand from '../commands/balance.ts';
import { cliCall } from './helpers/cli-call.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';
import { UnsupportedNodeError } from '../lib/node-version.ts';
import { LocalnetUnavailableError } from '../lib/localnet.ts';
import { scriptRuntime } from '../lib/contract/runner.ts';
import { NoSuchOfferError } from '../lib/swap/offers.ts';
import { NoAccountError } from '../lib/grant/prepare.ts';
import { NodeTooOldForAccountError, UnreachableByAccountError } from '../lib/grant/account.ts';
import { installedCommands } from '../lib/installed-commands.ts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mn-code-parity-'));
  saveWalletConfig({ seed: SEED.toString('hex'), addresses: ADDRESSES, createdAt: new Date(0).toISOString() }, join(root, 'wallets', 'alice.json'));
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const SEED = Buffer.from('00'.repeat(31) + '11', 'hex');
const ADDRESSES = deriveAllAddresses(SEED);
const OTHER_ADDRESSES = deriveAllAddresses(Buffer.from('00'.repeat(31) + '22', 'hex'));

/** A host on the test's state root, never ~/.midnight, with the engines mn ships. */
const hostOnRoot = () => createHost({ paths: { stateRoot: root, home: root }, engineLoader: loadInstalledEngine });
/** The command run as the shell runs it, on the test's state root. */
const run = <Protector>(handler: CommandHandler<Protector>, ...argv: string[]) => () => cliCall(handler, parseArgs(argv), { host: hostOnRoot() });

/** Nothing listens on port 9 here: a connection to it is refused. */
const CLOSED_WS = 'ws://127.0.0.1:9';
const CLOSED_HTTP = 'http://127.0.0.1:9';
/** The chain and the indexer stand in at the rc engine's repository seams: alice holds `night` and no Dust. */
const STAND_IN: NetworkConfig = { indexer: 'http://test/indexer', indexerWS: 'ws://test/indexer/ws', node: 'ws://test/node', proofServer: 'http://test/proof', networkId: 'Undeployed' };
const holding = (night: bigint) => createHost({
  paths: { stateRoot: root, home: root },
  engineLoader: async (_set, host) => createRcEngine(host, {
    repository: {
      fetchProtocolVersion: async () => 2001000n,
      fetchTip: async () => 'tip-1',
      fetchUnshielded: async () => ({ balances: new Map(night === 0n ? [] : [[NATIVE_TOKEN_TYPE, night]]), utxoCount: 1, txCount: 1, highestTxId: 1, registeredUtxos: 0, unregisteredUtxos: 1 }),
      fetchDust: async () => {
        const state = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
        return { balance: 0n, availableCoins: 0, eventCount: 0, ownedUtxoCount: 0, syncTime: state.syncTime, state, retention: { ownedGenerationIndices: [], generationFrontier: 0 }, lastAppliedEventId: 0, partial: false };
      },
    },
  }),
});

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

/** [where it is thrown, how to throw it, without the registry, with it, by its code alone (as with it, unless given)]. */
type Row = [string, () => unknown, Classified, Classified, Classified?];
const ROWS: Row[] = [
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
  // Arguments the message rules read as usage mistakes, now usage errors (approved: shown as "Usage").
  ['a required flag missing', () => requireFlag(parseArgs(['contract', 'call']), 'address', 'contract address'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['wallet generate with no name', run(walletCommand, 'wallet', 'generate'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['wallet generate with a seed and a mnemonic', run(walletCommand, 'wallet', 'generate', 'bob', '--seed', 'ab'.repeat(32), '--mnemonic', 'one two'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['wallet use with no name', run(walletCommand, 'wallet', 'use'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['wallet remove with no name', run(walletCommand, 'wallet', 'remove'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['a mnemonic off the wordlist', () => walletSecretFrom({ mnemonic: 'not a mnemonic' }), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['generate with a seed and a mnemonic', run(generateCommand, 'generate', '--seed', 'ab'.repeat(32), '--mnemonic', 'one two'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['generate with a mnemonic off the wordlist', run(generateCommand, 'generate', '--mnemonic', 'not a mnemonic'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['address with a negative key index', run(addressCommand, 'address', '--seed', 'ab'.repeat(32), '--index', '-1'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['airdrop with no amount', run(airdropCommand, 'airdrop'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ["balance of an address on another network than --network", run(balanceCommand, 'balance', OTHER_ADDRESSES.undeployed, '--network', 'preprod'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ["the shielded balance of someone else's address", run(balanceCommand, 'balance', OTHER_ADDRESSES.preview, '--shielded', '--network', 'preview'), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],
  ['a shielded transfer where shielded is off', () => resolveTransferRequest(parseArgs(['transfer', deriveAllShieldedAddresses(SEED).preprod, '1', '--wallet', 'alice', '--shielded', '--network', 'preprod']), root, hostOnRoot()), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],

  // No such wallet: exit 3, by its message.
  ['no wallet of that name', () => setActiveWallet(root, 'nobody'), as('WALLET_NOT_FOUND', 3), as('WALLET_NOT_FOUND', 3)],
  ['no wallet file', () => assertWalletFileExists(join(root, 'wallets', 'nobody.json')), as('WALLET_NOT_FOUND', 3), as('WALLET_NOT_FOUND', 3)],
  ['no wallet of that name to remove', () => assertWalletRemovable(root, 'nobody'), as('WALLET_NOT_FOUND', 3), as('WALLET_NOT_FOUND', 3)],

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
  ['no block within the wait', () => waitForFirstBlock(CLOSED_WS, { timeoutMs: 1, pollIntervalMs: 1 }), as('SYNC_TIMEOUT', 4), as('SYNC_TIMEOUT', 4)],
  ['no funds at the indexer within the wait', () => waitForAddressFunded(CLOSED_WS, ADDRESSES.undeployed, { timeoutMs: 1, pollIntervalMs: 1 }), as('SYNC_TIMEOUT', 4), as('SYNC_TIMEOUT', 4)],
  ['no proof server within the wait', () => waitForProofServerReady(CLOSED_HTTP, { timeoutMs: 1, pollIntervalMs: 1 }), as('SYNC_TIMEOUT', 4), as('SYNC_TIMEOUT', 4)],
  ['a node that refuses the connection', () => callNodeRpc({ url: CLOSED_WS }, 'chain_getHeader'), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  ['an indexer subscription refused', () => subscribeGraphqlWs(CLOSED_WS, { query: 'subscription { x }', variables: {}, timeoutMs: 5_000, idleMs: 1_000, onNext: () => true, buildResult: () => undefined }), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  ['a balance read refused', () => checkBalance(ADDRESSES.undeployed, CLOSED_WS), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  ['an indexer query refused (approved: was UNKNOWN)', () => queryIndexer(`${CLOSED_HTTP}/`, '{ x }', undefined, 5_000), as('UNKNOWN', 1), as('NETWORK_ERROR', 4)],
  // Approved: a program that ran past its limit keeps NETWORK_ERROR, which its message (ETIMEDOUT) gave it.
  ['a program past its time limit', () => { throw new ProgramTimedOutError('docker compose ps', 10_000); }, as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],

  // Balance: exit 5.
  ['a Dust fee not generated yet', () => { throw new DustFeeNotGeneratedError(planRegistration(526_587_115_818_352n, [TWENTY_NIGHT]), new Date('2026-10-05T04:05:23.000Z')); }, as('DUST_GENERATING', 5), as('DUST_GENERATING', 5)],
  ['Dust short of a fee', () => { throw dustShortError(1n, 2n, null); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ['a paying wallet with no NIGHT (approved: was UNKNOWN)', () => assertWalletCanPay({ network: 'undeployed', root, host: holding(0n), networkConfig: STAND_IN, endpoints: {} }, 'alice', silentSpinner()), as('UNKNOWN', 1), as('INSUFFICIENT_BALANCE', 5)],
  ['a paying wallet with no Dust', () => assertWalletCanPay({ network: 'undeployed', root, host: holding(5_000_000n), networkConfig: STAND_IN, endpoints: {} }, 'alice', silentSpinner()), as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  // A test run's Dust step, and an engine's shielded transfer, need a chain: their errors as those sites throw them.
  ["a test run's Dust not available", () => { throw new DustRequiredError('Dust not available after 90s. The chain may be slow — try again.'); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ["a test run's wallet with no NIGHT (approved: was UNKNOWN)", () => { throw new InsufficientBalanceError('Wallet has 0 NIGHT on preprod. Fund your wallet before running tests:\n  mn airdrop 100   (if faucet available)\n  Or transfer NIGHT from another wallet.'); }, as('UNKNOWN', 1), as('INSUFFICIENT_BALANCE', 5)],
  // A failed prep step reports its step's code.
  ['a prep step short of Dust', () => { throw new PrepStepFailedError('dust', new DustRequiredError('Dust not available after 90s. The chain may be slow — try again.')); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ['shielded NIGHT short of a transfer', () => { throw new InsufficientBalanceError('Insufficient shielded balance: 1.000000 NIGHT available, 2 NIGHT requested.\nFund shielded balance: midnight airdrop 2 --shielded'); }, as('INSUFFICIENT_BALANCE', 5), as('INSUFFICIENT_BALANCE', 5)],
  ["the genesis wallet's shielded NIGHT short of an airdrop", () => { throw new InsufficientBalanceError('Genesis wallet has insufficient shielded balance: 1.000000 NIGHT available, 2 NIGHT requested'); }, as('INSUFFICIENT_BALANCE', 5), as('INSUFFICIENT_BALANCE', 5)],

  // Refused transactions and stale state: exit 6.
  // It carries no code yet: its name and the node's words in its message classify it.
  ["the node's refusal", () => { throw new TransactionRefusedError('Invalid transaction'); }, as('TX_REJECTED', 6), as('TX_REJECTED', 6), as('UNKNOWN', 1)],
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
  ['a prep step that failed with no code', () => runPrepSteps({ network: 'undeployed', prep: ['no-such-step'] } as unknown as DappTestConfig, root, createPrepContext(root, hostOnRoot(), createSdkWarningRouter().openCall().warnings, new AbortController().signal), { onStepStart: () => {}, onStepComplete: () => {}, onMessage: () => {} }), as('UNKNOWN', 1), as('UNKNOWN', 1)],
];

describe('the code and exit code of each typed error', () => {
  it.each(ROWS)('%s', async (_where, throwIt, before, now, byCode = now) => {
    const err = await thrownBy(throwIt);
    expect(classifyError(err)).toStrictEqual(before);
    expect(classifyError(err, installedCommands)).toStrictEqual(now);
    expect(classifyByCode(err, installedCommands)).toStrictEqual(byCode);
  });
});
