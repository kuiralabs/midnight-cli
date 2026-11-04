// What each typed error, thrown where mn throws it, reports: its code and the
// exit code it ends the CLI with, classified by its code through the installed
// registry, as the shell and the MCP server classify it. Each row also records
// what mn reported before codes were owned per package, when the message rules
// still read an error's words (removed since; the record is kept, not
// computed). The two differ only on rows marked approved: (Y52) NO_STATE_ROOT,
// NO_PAYER and NO_NODE_RUNTIME by name instead of UNKNOWN, an escaped stale
// cache as STALE_CACHE, and a failed command run through MCP as
// COMMAND_FAILED; (Y53) a wallet with no NIGHT as INSUFFICIENT_BALANCE and an
// unreachable indexer, node or proof server as NETWORK_ERROR, whatever their
// messages say; and (Y54) a ZK proof that timed out as PROOF_TIMEOUT, and a
// contract run's transaction the node refused as TX_REJECTED whatever its
// reason's words. A test checks that every row that changed says so.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError, CancelledError, CommandFailedError, DustRequiredError, InsufficientBalanceError, SyncTimeoutError, TransactionRefusedError, UsageError, createApiError, OPERATOR_REJECTED_MESSAGE, withTransportCode, parseArgs, requireFlag, dustShortError, ProgramTimedOutError, NATIVE_TOKEN_TYPE, type NetworkConfig, type CommandHandler, createHost, payerFor, openSecret, sealSecret, checkTerms, assertOfferUnexpired, OfferCoinsInUseError, AmbiguousLocalStacksError, BlockfrostLimitError, BlockfrostProjectIdRejectedError, BlockfrostProjectIdRequiredError, EndpointShutDownError, OtherSdkSetError, createSdkWarningRouter } from '@kuiralabs/midnight-cli-core';
import { silentSpinner } from '@kuiralabs/midnight-cli-core/ui';
import { ProofTimeoutError, withEngineCode, NotAnOfferError, MixedSdkLayoutError, DustFeeNotGeneratedError, planRegistration } from '@kuiralabs/midnight-cli-core/engine';
import { Effect } from 'effect';
import { SubmissionError } from '@midnightntwrk/wallet-sdk/capabilities/submission';
import { ProvingError } from '@midnightntwrk/wallet-sdk/capabilities/proving';
import { InsufficientFundsError as NoCoinsCoverIt } from '@midnightntwrk/wallet-sdk/capabilities';
import { WalletError } from '@midnightntwrk/wallet-sdk/dust/v2';
import { scriptFailureAtServe } from './helpers/serve-script-failure.ts';
import { closedPort } from '../../test-support/closed-port.ts';
import { SCRIPT_PRELUDE, executeScript, rpcClientCode } from '../lib/contract/runner.ts';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { LocalStackUnreachableError, UnsupportedLedgerError, ChainClockBehindError, waitForFirstBlock, waitForAddressFunded, waitForProofServerReady, callNodeRpc, subscribeGraphqlWs, checkBalance, queryIndexer } from '@kuiralabs/midnight-chain';
import { createRcEngine } from '@kuiralabs/midnight-engine-rc';
import { rcKeys } from '../../test-support/rc-engine.ts';
import * as ledger from '@midnightntwrk/ledger-v9';
import { readPassphrase } from '../lib/passphrase.ts';
import { assertWalletFileExists, assertWalletRemovable, setActiveWallet } from '../lib/wallet-config.ts';
import { walletSecretFrom } from '../lib/wallet-create.ts';
import { resolveTransferRequest } from '../lib/transfer-request.ts';
import { assertWalletCanPay } from '../lib/wallet-can-pay.ts';
import { PrepStepFailedError, runPrepSteps } from '../lib/test/prep-runner.ts';
import { createPrepContext, type DappTestConfig } from '../lib/test/types.ts';
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
const ADDRESSES = rcKeys.unshieldedAddresses(SEED);
const OTHER_ADDRESSES = rcKeys.unshieldedAddresses(Buffer.from('00'.repeat(31) + '22', 'hex'));

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

/** The SDK's promise rejection for a failed Effect: a FiberFailure holding the error. */
function sdkRejection(error: Error): Promise<never> {
  const failure = Effect.runPromise(Effect.fail(error));
  failure.catch(() => {});
  return failure as Promise<never>;
}
const nodeRefusal = (reason: string) => () => sdkRejection(new SubmissionError({ message: 'Transaction submission error', cause: new Error(reason) }));
/** The rc engine's wallet reading a balance when the SDK fails with `failure` under it, at its repository's indexer seam. */
const throughRcEngine = (failure: () => Promise<never>) => () => createRcEngine(createHost({ paths: { stateRoot: root, home: root } }), {
  repository: { fetchUnshielded: failure, fetchTip: async () => 'tip-1' },
}).wallet.unshieldedBalance(ADDRESSES.undeployed, STAND_IN, { forceFresh: true });
/** The connector's answer to a submission the node refused with `reason`: its own words over the SDK's error, marked with mn's code. */
const connectorRefusal = async (reason: string) => {
  const thrown = await nodeRefusal(reason)().catch((e: Error) => e);
  return withEngineCode(new Error(`Transaction submission failed: [SubmissionError] Transaction submission error → ${reason}`, { cause: thrown }));
};

/** A socket's refusal: what a WebSocket to a closed port fails with (ECONNREFUSED its code). */
async function refusedSocket(): Promise<Error> {
  const port = await closedPort();
  return new Promise((resolve) => { new WebSocket(`ws://127.0.0.1:${port}`).on('error', resolve); });
}
/** What the runner rejects with when a generated script, its prelude first, runs `body` and fails. */
async function scriptFailing(body: (port: number) => string): Promise<never> {
  const dir = mkdtempSync(join(tmpdir(), 'mn-code-parity-script-'));
  try {
    const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
    const port = await closedPort();
    await executeScript({ dir, script: SCRIPT_PRELUDE + rpcClientCode(port, wsModule) + body(port), overlaySdk: false, packages: { packages: [], packageFolder: () => null, set: 'rc' } });
    throw new Error('expected the script to fail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

/** [where it is thrown, how to throw it, what mn reported before codes were owned per package (a record), what it reports]. */
type Row = [string, () => unknown, Classified, Classified];
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
  ['a shielded transfer where shielded is off', () => resolveTransferRequest(parseArgs(['transfer', rcKeys.shieldedAddresses(SEED).preprod, '1', '--wallet', 'alice', '--shielded', '--network', 'preprod']), root, hostOnRoot()), as('INVALID_ARGS', 2), as('INVALID_ARGS', 2)],

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
  // Connections the SDK, a contract script or the account package could not make, named where they are met.
  ["a socket's refusal, through the engine", throughRcEngine(async () => { throw await refusedSocket(); }), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  ['fetch failing, through the engine (approved Y53: was UNKNOWN)', throughRcEngine(async () => { await fetch(`http://127.0.0.1:${await closedPort()}/`); throw new Error('expected fetch to fail'); }), as('UNKNOWN', 1), as('NETWORK_ERROR', 4)],
  ['a contract script that cannot reach mn serve', () => scriptFailing(() => 'await rpcConnect();\n'), as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  ["a contract script's fetch failing (approved Y53: was UNKNOWN)", () => scriptFailing((port) => `await fetch('http://127.0.0.1:${port}/');\n`), as('UNKNOWN', 1), as('NETWORK_ERROR', 4)],
  ["the account package's refused connection, at grant's boundary", async () => { throw withTransportCode(await refusedSocket()); }, as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],
  // Approved: a program that ran past its limit keeps NETWORK_ERROR, which its message (ETIMEDOUT) gave it.
  ['a program past its time limit', () => { throw new ProgramTimedOutError('docker compose ps', 10_000); }, as('NETWORK_ERROR', 4), as('NETWORK_ERROR', 4)],

  // Balance: exit 5.
  ['a Dust fee not generated yet', () => { throw new DustFeeNotGeneratedError(planRegistration(526_587_115_818_352n, [TWENTY_NIGHT]), new Date('2026-10-05T04:05:23.000Z')); }, as('DUST_GENERATING', 5), as('DUST_GENERATING', 5)],
  ['Dust short of a fee', () => { throw dustShortError(1n, 2n, null); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ['a paying wallet with no NIGHT (approved: was UNKNOWN)', () => assertWalletCanPay({ network: 'undeployed', root, host: holding(0n), networkConfig: STAND_IN, endpoints: {} }, 'alice', silentSpinner()), as('UNKNOWN', 1), as('INSUFFICIENT_BALANCE', 5)],
  ['a paying wallet with no Dust', () => assertWalletCanPay({ network: 'undeployed', root, host: holding(5_000_000n), networkConfig: STAND_IN, endpoints: {} }, 'alice', silentSpinner()), as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  // A test run's Dust step, and an engine's shielded transfer, need a chain: their errors as those sites throw them.
  ['the SDK short of Dust, through the engine', throughRcEngine(() => sdkRejection(new WalletError.InsufficientFundsError({ message: new NoCoinsCoverIt('dust').message, tokenType: 'dust' }))), as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ['the SDK short of NIGHT, through the engine', throughRcEngine(() => sdkRejection(new WalletError.InsufficientFundsError({ message: new NoCoinsCoverIt(NATIVE_TOKEN_TYPE).message, tokenType: NATIVE_TOKEN_TYPE }))), as('INSUFFICIENT_BALANCE', 5), as('INSUFFICIENT_BALANCE', 5)],
  ['a contract run short of Dust at mn serve', () => scriptFailureAtServe(() => createApiError('InternalError', "Not enough Dust available for this transaction's fee: the wallet has 0.35 DUST and the fee takes 2.00.", 'DUST_REQUIRED')).then((err) => { throw err; }), as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ["a test run's Dust not available", () => { throw new DustRequiredError('Dust not available after 90s. The chain may be slow — try again.'); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ["a test run's wallet with no NIGHT (approved: was UNKNOWN)", () => { throw new InsufficientBalanceError('Wallet has 0 NIGHT on preprod. Fund your wallet before running tests:\n  mn airdrop 100   (if faucet available)\n  Or transfer NIGHT from another wallet.'); }, as('UNKNOWN', 1), as('INSUFFICIENT_BALANCE', 5)],
  // A failed prep step reports its step's code.
  ['a prep step short of Dust', () => { throw new PrepStepFailedError('dust', new DustRequiredError('Dust not available after 90s. The chain may be slow — try again.')); }, as('DUST_REQUIRED', 5), as('DUST_REQUIRED', 5)],
  ['shielded NIGHT short of a transfer', () => { throw new InsufficientBalanceError('Insufficient shielded balance: 1.000000 NIGHT available, 2 NIGHT requested.\nFund shielded balance: midnight airdrop 2 --shielded'); }, as('INSUFFICIENT_BALANCE', 5), as('INSUFFICIENT_BALANCE', 5)],
  ["the genesis wallet's shielded NIGHT short of an airdrop", () => { throw new InsufficientBalanceError('Genesis wallet has insufficient shielded balance: 1.000000 NIGHT available, 2 NIGHT requested'); }, as('INSUFFICIENT_BALANCE', 5), as('INSUFFICIENT_BALANCE', 5)],

  // Refused transactions and stale state: exit 6.
  ["the node's refusal", () => { throw new TransactionRefusedError('Invalid transaction'); }, as('TX_REJECTED', 6), as('TX_REJECTED', 6)],
  // The engine's boundary: the SDK's own errors, reported by the rc engine's wallet.
  ['the node refusing a spent coin, through the engine', throughRcEngine(nodeRefusal('1010: Invalid Transaction: Custom error: 115')), as('STALE_UTXO', 6), as('STALE_UTXO', 6)],
  ['the node refusing a Dust proof, through the engine', throughRcEngine(nodeRefusal('1010: Invalid Transaction: Custom error: 170')), as('INVALID_DUST_PROOF', 6), as('INVALID_DUST_PROOF', 6)],
  ['the node refusing for another reason, through the engine', throughRcEngine(nodeRefusal('1010: Invalid Transaction: Custom error: 199')), as('TX_REJECTED', 6), as('TX_REJECTED', 6)],
  ['the proof server failing, through the engine', throughRcEngine(() => sdkRejection(new ProvingError({ message: 'Failed to prove transaction', cause: new Error('connect ECONNREFUSED 127.0.0.1:6300') }))), as('PROOF_FAILURE', 6), as('PROOF_FAILURE', 6)],
  ["a saved state the indexer's events don't fit, through the engine", throughRcEngine(() => Promise.reject(new Error('Failed applying dust events: commitment inserted non-linearly'))), as('STALE_CACHE', 6), as('STALE_CACHE', 6)],
  ['a wallet sync past its deadline, in the engine', () => { throw new SyncTimeoutError('Wallet sync timed out'); }, as('SYNC_TIMEOUT', 4), as('SYNC_TIMEOUT', 4)],
  ['a ZK proof that timed out, in the engine (approved Y54: was UNKNOWN)', () => { throw new ProofTimeoutError(); }, as('UNKNOWN', 1), as('PROOF_TIMEOUT', 6)],
  // A program's wallet session (the connector in this process) and an escaped stale cache are the engines' own errors: their rows are in each engine's tests (wallet-session.test.ts, stale-cache.test.ts).
  // A contract run: the connector at mn serve, the wire, and the script's process.
  ['a contract run the node refused at mn serve (approved Y54: was UNKNOWN)', async () => { const refusal = await connectorRefusal('1010: Invalid Transaction: Custom error: 199'); return scriptFailureAtServe(() => refusal).then((err) => { throw err; }); }, as('UNKNOWN', 1), as('TX_REJECTED', 6)],
  ['a contract run refused a spent coin at mn serve', async () => { const refusal = await connectorRefusal('1010: Invalid Transaction: Custom error: 115'); return scriptFailureAtServe(() => refusal).then((err) => { throw err; }); }, as('STALE_UTXO', 6), as('STALE_UTXO', 6)],
  ['a contract run whose proof timed out at mn serve (approved Y54: was UNKNOWN)', () => scriptFailureAtServe(() => new ProofTimeoutError()).then((err) => { throw err; }), as('UNKNOWN', 1), as('PROOF_TIMEOUT', 6)],
  ['a contract run the operator refused at mn serve', () => scriptFailureAtServe(() => createApiError('Rejected', OPERATOR_REJECTED_MESSAGE, 'TX_REJECTED')).then((err) => { throw err; }), as('TX_REJECTED', 6), as('TX_REJECTED', 6)],

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
  it.each(ROWS)('%s', async (_where, throwIt, _before, now) => {
    expect(classifyError(await thrownBy(throwIt), installedCommands)).toStrictEqual(now);
  });

  it('marks every row whose code changed as approved', () => {
    const changed = ROWS.filter(([, , before, now]) => before.errorCode !== now.errorCode || before.exitCode !== now.exitCode);
    expect(changed.length).toBeGreaterThan(0);
    for (const [where] of changed) expect(where).toMatch(/\(approved\b/);
  });
});
