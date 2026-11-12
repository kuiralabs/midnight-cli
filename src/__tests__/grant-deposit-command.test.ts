// `grant deposit` through the command as the shell runs it, up to the account
// package's deposit: which balance the pre-check reads, what it refuses with,
// and what the deposit is called with, for NIGHT and for another token. Nothing
// reaches a chain: the payer stands in for the wallet session (it opens no
// wallet), and the network's engine is the one mn ships, with only the account
// package's deposit entry point standing in, where the package would reach the
// indexer and the proof server. The state root is the test's own, never ~/.midnight.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHost, parseArgs, NATIVE_TOKEN_TYPE, UsageError, type Host, type Payer, type WalletSession } from '@kuiralabs/midnight-cli-core';
import { grantDefinition } from '@kuiralabs/midnight-grant/commands';
import { captureOutput, type CapturedOutput } from '../../test-support/capture-output.ts';
import { loadInstalledEngine } from '../../test-support/test-host.ts';
import { stateRootIn } from '../../test-support/state-root-in.ts';
import { cliCall } from './helpers/cli-call.ts';

// The handler, as the shell loads it.
const { default: grantCommand } = await grantDefinition.load();

const ACCOUNT = '5e'.repeat(32);
const TOKEN = '02005c8a9e3d6e3a2b0e1c4f7d9a8b6c5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const TX_HASH = 'c4'.repeat(32);
// The transaction's identifier, which mn gives as txHash (as every other command does); TX_HASH is its 64-hex hash.
const TX_ID = '00' + 'd5'.repeat(32);
const ENDPOINTS = ['--network', 'undeployed', '--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];

/** One call of the account package's depositShielded: every argument after the connection, as given. */
type DepositCall = unknown[];

let home: string;
let io: CapturedOutput;
let deposits: DepositCall[];
let connections: number;

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'mn-grant-deposit-')));
  // An account an earlier mn wrote in plain text for alice: opened without a passphrase.
  const records = path.join(stateRootIn(home), 'accounts', 'undeployed', 'alice');
  fs.mkdirSync(records, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(records, 'owner.json'), JSON.stringify({ contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) }), { mode: 0o600 });
  io = captureOutput();
  deposits = [];
  connections = 0;
});

afterEach(() => {
  io.restore();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A host on the test's state root whose engines are mn's own, the account package's deposit entry point recording its calls. */
function hostRecordingDeposits(): Host {
  return createHost({
    paths: { stateRoot: stateRootIn(home), home },
    engineLoader: async (set, loading) => {
      const engine = await loadInstalledEngine(set, loading);
      return {
        ...engine,
        account: async () => ({
          ...(await engine.account()),
          deposit: {
            connectOver: async () => { connections += 1; return {}; },
            depositShielded: async (_connection: unknown, ...rest: unknown[]) => {
              deposits.push(rest);
              return { coin: {}, result: { public: { txHash: TX_HASH, txId: TX_ID, blockHeight: 42n } } };
            },
          },
        }),
      };
    },
  });
}

/** A payer whose wallet holds `shielded` (raw token type to smallest units) and Dust to pay with; its session reads balances and addresses, nothing else. */
function payerHolding(shielded: Record<string, bigint>): Payer {
  const unused = async (): Promise<never> => { throw new Error('not used by a deposit before the account package submits'); };
  const session: WalletSession = {
    network: 'undeployed',
    addresses: async () => ({ unshielded: 'mn_addr_undeployed1alice', shielded: 'mn_shield-addr_undeployed1alice', shieldedCoinPublicKey: '11'.repeat(32), shieldedEncryptionPublicKey: '22'.repeat(32), dust: 'mn_dust_undeployed1alice' }),
    balances: async () => ({ unshielded: {}, shielded, dust: 10n ** 18n }),
    balanceTransaction: unused,
    swap: unused,
    makeOffer: unused,
    takeOffer: unused,
    cancelOffers: unused,
    holdsFreeCoin: unused,
    splitCoin: unused,
    sign: unused,
    submit: unused,
    readTransaction: unused,
    close: async () => {},
  };
  return {
    assertCanPay: async () => ({ nightBalance: 10n ** 12n, dustBalance: 10n ** 18n }),
    serve: unused,
    connect: async (_target, _wallet, _progress, _sdkWarnings, _signal, options) => { connectOptions.push(options); return session; },
  };
}

/** What each connect was asked for: a deposit spends shielded coins, so it asks for the shielded side synced (a network that skips the shielded sync by default would read none otherwise). */
const connectOptions: unknown[] = [];

const deposit = (payer: Payer, ...argv: string[]) =>
  cliCall(grantCommand, parseArgs(['grant', 'deposit', ...argv, '--wallet', 'alice', ...ENDPOINTS, '--json']), { host: hostRecordingDeposits(), payer });

/** The JSON result the call wrote to stdout. */
const resultLine = (): Record<string, unknown> => JSON.parse(io.stdout().trim().split('\n').at(-1)!) as Record<string, unknown>;

describe('grant deposit --token', () => {
  it('asks its wallet for the shielded side synced: the coins it deposits are shielded (regression: a network that skips the shielded sync read 0)', async () => {
    connectOptions.length = 0;
    await deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 0n, [TOKEN]: 10n }), '5', '--token', TOKEN);
    expect(connectOptions).toEqual([{ shielded: true }]);
  });

  it('deposits the token: the account package gets the value exactly and the raw type\'s 32 bytes as the color', async () => {
    const value = 340282366920938463463374607431768211455n;
    await deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 0n, [TOKEN]: value }), value.toString(), '--token', TOKEN.toUpperCase());

    expect(deposits).toEqual([[value, new Uint8Array(Buffer.from(TOKEN, 'hex'))]]);
    expect(resultLine()).toMatchObject({ subcommand: 'deposit', address: ACCOUNT, amount: value.toString(), value: value.toString(), token: TOKEN, txHash: TX_ID, blockHeight: 42 });
  });

  it('refuses before anything is built when the wallet holds less of the token, naming it and both amounts', async () => {
    // Plenty of shielded NIGHT: the check reads the token's balance, not NIGHT's.
    const outcome = deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 10n ** 12n, [TOKEN]: 499n }), '500', '--token', TOKEN);

    await expect(outcome).rejects.toThrow(UsageError);
    await expect(outcome).rejects.toThrow(`Not enough of token ${TOKEN} for this deposit: the wallet holds 499 of it shielded and the deposit takes 500, in the token's smallest unit.`);
    expect(connections).toBe(0);
    expect(deposits).toEqual([]);
  });

  it('refuses a token the wallet holds none of', async () => {
    await expect(deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 10n ** 12n }), '1', '--token', TOKEN)).rejects.toThrow(`the wallet holds 0 of it shielded and the deposit takes 1,`);
    expect(deposits).toEqual([]);
  });
});

describe('grant deposit of NIGHT, without --token', () => {
  it('calls the deposit with the value alone, the package\'s default color (NIGHT), and names no token', async () => {
    await deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 2_000_000n, [TOKEN]: 10n ** 9n }), '2');

    expect(deposits).toEqual([[2_000_000n]]);
    const result = resultLine();
    expect(result).toMatchObject({ subcommand: 'deposit', address: ACCOUNT, amount: '2', value: '2000000', txHash: TX_ID, blockHeight: 42 });
    expect(result).not.toHaveProperty('token');
  });

  it('refuses on the shielded NIGHT, in NIGHT, however much of another token the wallet holds', async () => {
    const outcome = deposit(payerHolding({ [NATIVE_TOKEN_TYPE]: 1_500_000n, [TOKEN]: 10n ** 9n }), '2');

    await expect(outcome).rejects.toThrow(UsageError);
    await expect(outcome).rejects.toThrow('Not enough shielded NIGHT for this deposit: the wallet holds 1.500000 NIGHT shielded and the deposit takes 2.000000 NIGHT.');
    expect(connections).toBe(0);
    expect(deposits).toEqual([]);
  });
});
