// A wallet session: what a program holds of a wallet (D29). It opens a wallet
// through the engine for the network's SDK set and calls operations that read
// the same on every set; the engine keeps the SDK's objects and the secret
// keys. The session is the engine's DApp connector in this process, approving
// everything (the program is the operator), so its rules hold here too: a
// transaction balanced or built but never submitted is reverted on close, and
// one the chain refuses is reverted at once. Transactions travel as hex.

import { engineFor, type DAppConnector, type OpenedConnector, type TransactionDetail } from './engine.ts';
import type { NetworkConfig, NetworkName } from './network.ts';
import { resolveNetwork } from './resolve-network.ts';
import { shieldedSyncEnabled } from './shielded-policy.ts';
import { throwIfCancelled } from './errors.ts';

/** The calls a session makes, under one connection name for the connector's pending transactions. */
const SESSION_CONNECTION = 'wallet-session';

/** A wallet's addresses on the session's network, bech32m, and its shielded keys, hex. */
export interface WalletAddresses {
  unshielded: string;
  shielded: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  dust: string;
}

/** What a wallet holds: tokens by their raw type, each in its smallest unit. */
export interface WalletBalances {
  unshielded: Record<string, bigint>;
  shielded: Record<string, bigint>;
  /** Dust, in its smallest unit. */
  dust: bigint;
}

/** An amount of one token: its raw type (hex) and its kind. */
export interface TokenAmount {
  kind: 'shielded' | 'unshielded';
  type: string;
  value: bigint;
}

/** An amount paid to a recipient's address (bech32m) on the session's network. */
export interface TokenPayment extends TokenAmount {
  recipient: string;
}

/** Data signed with the wallet's unshielded key. */
export interface SignedData {
  data: string;
  signature: string;
  verifyingKey: string;
  scheme: string;
}

export interface WalletSession {
  readonly network: NetworkName;
  addresses(): Promise<WalletAddresses>;
  balances(): Promise<WalletBalances>;
  /** Pays the fees of an unsealed transaction (hex) and adds what its outputs need; the balanced transaction, sealed. */
  balanceTransaction(tx: string): Promise<string>;
  /** A swap offer: the wallet gives `give` for `take`, paying its fees; the transaction to submit or hand on. */
  swap(give: TokenAmount[], take: TokenPayment[]): Promise<string>;
  /** Signs `data` (hex, base64 or text, as `encoding` says) with the wallet's unshielded key. */
  sign(data: string, encoding: 'hex' | 'base64' | 'text'): Promise<SignedData>;
  /** Submits a sealed transaction (hex) and waits for it to be finalized; its hash. */
  submit(tx: string): Promise<string>;
  /** What a transaction (hex) is, as an approval prompt shows it. */
  readTransaction(tx: string, stage: 'unsealed' | 'sealed'): Promise<TransactionDetail[]>;
  /** Reverts what was balanced or built but never submitted, then stops the wallet. */
  close(): Promise<void>;
}

/** The session over a connector opened in this process; closing it stops the connector. */
export function sessionOver(
  network: NetworkName,
  opened: OpenedConnector,
  readTransaction: (tx: string, stage: 'unsealed' | 'sealed') => TransactionDetail[],
): WalletSession {
  const { connector } = opened;
  let requestId = 0;
  let closed = false;
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (closed) throw new Error('The wallet session is closed');
    const handler = handlerOf(connector, method);
    return handler(params, { notify: () => {}, connectionId: SESSION_CONNECTION, requestId: ++requestId, metadata: {} });
  };

  return {
    network,
    async addresses() {
      const { unshieldedAddress } = (await call('getUnshieldedAddress', {})) as { unshieldedAddress: string };
      const shielded = (await call('getShieldedAddresses', {})) as { shieldedAddress: string; shieldedCoinPublicKey: string; shieldedEncryptionPublicKey: string };
      const { dustAddress } = (await call('getDustAddress', {})) as { dustAddress: string };
      return {
        unshielded: unshieldedAddress,
        shielded: shielded.shieldedAddress,
        shieldedCoinPublicKey: shielded.shieldedCoinPublicKey,
        shieldedEncryptionPublicKey: shielded.shieldedEncryptionPublicKey,
        dust: dustAddress,
      };
    },
    async balances() {
      const unshielded = (await call('getUnshieldedBalances', {})) as Record<string, bigint>;
      const shielded = (await call('getShieldedBalances', {})) as Record<string, bigint>;
      const { balance } = (await call('getDustBalance', {})) as { balance: bigint };
      return { unshielded: { ...unshielded }, shielded: { ...shielded }, dust: balance };
    },
    async balanceTransaction(tx) {
      return ((await call('balanceUnsealedTransaction', { tx })) as { tx: string }).tx;
    },
    async swap(give, take) {
      const result = await call('makeIntent', {
        desiredInputs: give.map(({ kind, type, value }) => ({ kind, type, value })),
        desiredOutputs: take.map(({ kind, type, value, recipient }) => ({ kind, type, value, recipient })),
        options: { payFees: true },
      });
      return (result as { tx: string }).tx;
    },
    async sign(data, encoding) {
      return (await call('signData', { data, options: { encoding, keyType: 'unshielded' } })) as SignedData;
    },
    async submit(tx) {
      return ((await call('submitTransaction', { tx })) as { txHash: string }).txHash;
    },
    async readTransaction(tx, stage) {
      if (closed) throw new Error('The wallet session is closed');
      return readTransaction(tx, stage);
    },
    async close() {
      if (closed) return;
      closed = true;
      await connector.revertPendingTxs(SESSION_CONNECTION).catch(() => { /* best-effort: the wallet is stopping */ });
      await opened.stop();
    },
  };
}

function handlerOf(connector: DAppConnector, method: string) {
  const handler = connector.handlers[method];
  if (handler === undefined) throw new Error(`The wallet's connector has no ${method}`);
  return handler;
}

export interface OpenWalletSessionOptions {
  /** The wallet's seed: 64 bytes from a mnemonic, or 32 raw. */
  seed: Buffer;
  network: NetworkName;
  /** The network's endpoints; when absent, as a command without endpoint flags resolves them (the saved config, then the defaults). */
  networkConfig?: NetworkConfig;
  /** Whether to sync the shielded wallet; off where the network has no shielded faucet, unless forced. */
  forceShielded?: boolean;
  /** How long to wait for the wallet's Dust once synced, in milliseconds; the connector's default when absent. */
  dustWaitMs?: number;
  /** Cancels the open: what was started is stopped. */
  signal?: AbortSignal;
  /** What the open is doing now, for a progress line. */
  onMessage?: (message: string) => void;
}

/**
 * Opens a seed's wallet on a network: synced, its Dust ready. The host must
 * have installed its engine loader, settings and state root first, as the CLI
 * does at start.
 */
export async function openWalletSession(options: OpenWalletSessionOptions): Promise<WalletSession> {
  const { seed, network, signal } = options;
  throwIfCancelled(signal);
  const networkConfig = options.networkConfig
    ?? resolveNetwork({ args: { command: 'wallet-session', subcommand: '', positionals: [], flags: { network } } }).config;
  const engine = await engineFor(network);
  const opened = await engine.wallet.openConnector({
    seed,
    network,
    networkConfig,
    address: engine.keys.unshieldedAddress(seed, network),
    syncMode: shieldedSyncEnabled(network, options.forceShielded) ? 'full' : 'lite',
    dustWaitMs: options.dustWaitMs,
    signal,
    onMessage: options.onMessage ?? (() => {}),
  });
  return sessionOver(network, opened, (tx, stage) => engine.ledger.readTransaction(tx, stage));
}
