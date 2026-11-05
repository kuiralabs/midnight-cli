// A wallet session: what a program holds of a wallet (D29). It opens a wallet
// through the engine for the network's SDK set and calls operations that read
// the same on every set; the engine keeps the SDK's objects and the secret
// keys. The session is the engine's DApp connector in this process, approving
// everything (the program is the operator), so its rules hold here too: a
// transaction balanced or built but never submitted is reverted on close, and
// one the chain refuses is reverted at once. Transactions travel as hex.
//
// Just after a wallet opens, the SDK can refuse for lack of NIGHT the wallet
// has (its coin index isn't built yet: the cold-start race the CLI's own
// writes retry). Until the session has built its first transaction, it meets
// that by reopening the wallet and asking again, a few times.

import { sdkSetOf, type DAppConnector, type HostEngines, type OpenedConnector, type TransactionDetail } from './engine.ts';
import type { NetworkConfig, NetworkName } from './network.ts';
import type { NoticeSink } from './notices.ts';
import { resolveNetwork, type NetworkSettings } from './resolve-network.ts';
import { settingsFromEnvironment } from './settings.ts';
import { shieldedSyncEnabled } from './shielded-policy.ts';
import { throwIfCancelled } from './errors.ts';
import { isColdStartRace, toEngineError } from './sdk-errors.ts';
import type { SwapLeg } from './swap-offer.ts';
import type { OpenOffer } from './open-offers.ts';
import type { CallSdkWarnings } from './sdk-warnings.ts';

/** The calls a session makes, under one connection name for the connector's pending transactions. */
const SESSION_CONNECTION = 'wallet-session';
/** How many times a session asks for its first transaction through the cold-start race, in all. */
const COLD_START_ATTEMPTS = 5;
/** The wait before reopening the wallet, which gives the indexer time to settle. */
const COLD_START_DELAY_MS = 5_000;

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
  /**
   * The maker's half of a shielded swap: it gives `give` and is paid `want` to
   * its own shielded address, paying no fee (the taker pays the swap's). The
   * offer (sealed, hex) is handed off: closing the session doesn't cancel it.
   */
  makeOffer(give: SwapLeg, want: SwapLeg): Promise<string>;
  /**
   * Takes a swap offer (sealed, hex): the offer is validated before anything
   * is built, then this wallet adds its half and the fee. The swap (sealed,
   * hex), to submit. Check the terms and that the offer is live first.
   */
  takeOffer(tx: string): Promise<string>;
  /** Whether the wallet holds a shielded coin worth exactly `leg`, unspent and in none of its open swap offers. */
  holdsFreeCoin(leg: SwapLeg): Promise<boolean>;
  /**
   * Splits a coin: sends `leg` to the wallet's own shielded address, from its
   * coins in no open offer, which leaves it a coin worth exactly that and the
   * change (a fee in Dust). The transaction (sealed, hex), to submit.
   */
  splitCoin(leg: SwapLeg): Promise<string>;
  /** Cancels open swap offers of this wallet's by spending their coins back to itself (a fee in Dust); the cancel (sealed, hex), to submit. */
  cancelOffers(offers: readonly OpenOffer[]): Promise<string>;
  /** Signs `data` (hex, base64 or text, as `encoding` says) with the wallet's unshielded key. */
  sign(data: string, encoding: 'hex' | 'base64' | 'text'): Promise<SignedData>;
  /** Submits a sealed transaction (hex) and waits for it to be finalized; its hash. */
  submit(tx: string): Promise<string>;
  /** What a transaction (hex) is, as an approval prompt shows it. */
  readTransaction(tx: string, stage: 'unsealed' | 'sealed'): Promise<TransactionDetail[]>;
  /** Reverts what was balanced or built but never submitted, then stops the wallet. */
  close(): Promise<void>;
}

export interface SessionReopening {
  /** Opens the same wallet again, as it was first opened. */
  reopen: () => Promise<OpenedConnector>;
  /** What the session is doing, for a progress line. */
  onMessage?: (message: string) => void;
  /** The wait before each reopening, in milliseconds. */
  delayMs?: number;
}

/**
 * The session over a connector opened in this process; closing it stops the
 * connector. With `reopening`, the session meets the cold-start race before
 * its first transaction by reopening the wallet.
 */
export function sessionOver(
  network: NetworkName,
  opened: OpenedConnector,
  readTransaction: (tx: string, stage: 'unsealed' | 'sealed') => TransactionDetail[],
  reopening?: SessionReopening,
): WalletSession {
  let current = opened;
  let requestId = 0;
  let closed = false;
  // Once a transaction is built, reopening would revert it under the caller.
  let built = false;
  // The connector answers as it answers a dApp; the session reports its failures as the engine does (a node's refusal in the node's words, each with its code).
  const reported = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (err) {
      throw toEngineError(err);
    }
  };
  const call = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (closed) throw new Error('The wallet session is closed');
    const handler = handlerOf(current.connector, method);
    return reported(() => handler(params, { notify: () => {}, connectionId: SESSION_CONNECTION, requestId: ++requestId, metadata: {} }));
  };
  /** Builds a transaction, through the cold-start race while it is the session's first. */
  const build = async (making: () => Promise<string>): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      try {
        const tx = await making();
        built = true;
        return tx;
      } catch (err) {
        if (built || reopening === undefined || attempt >= COLD_START_ATTEMPTS || !isColdStartRace(err)) throw err;
        reopening.onMessage?.(`Refreshing wallet state (attempt ${attempt + 1}/${COLD_START_ATTEMPTS})...`);
        await current.stop();
        await new Promise((resolve) => setTimeout(resolve, reopening.delayMs ?? COLD_START_DELAY_MS));
        if (closed) throw new Error('The wallet session is closed');
        current = await reopening.reopen();
      }
    }
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
      return build(async () => ((await call('balanceUnsealedTransaction', { tx })) as { tx: string }).tx);
    },
    async swap(give, take) {
      return build(async () => ((await call('makeIntent', {
        desiredInputs: give.map(({ kind, type, value }) => ({ kind, type, value })),
        desiredOutputs: take.map(({ kind, type, value, recipient }) => ({ kind, type, value, recipient })),
        options: { payFees: true },
      })) as { tx: string }).tx);
    },
    async makeOffer(give, want) {
      const { shieldedAddress } = (await call('getShieldedAddresses', {})) as { shieldedAddress: string };
      const offer = await build(async () => ((await call('makeIntent', {
        desiredInputs: [{ kind: 'shielded', type: give.token, value: give.amount }],
        desiredOutputs: [{ kind: 'shielded', type: want.token, value: want.amount, recipient: shieldedAddress }],
        options: { intentId: 'random', payFees: false },
      })) as { tx: string }).tx);
      current.connector.handOffPendingTx(SESSION_CONNECTION, offer);
      return offer;
    },
    async holdsFreeCoin(leg) {
      if (closed) throw new Error('The wallet session is closed');
      return current.connector.holdsFreeCoin(leg.token, leg.amount);
    },
    async splitCoin(leg) {
      const { shieldedAddress } = (await call('getShieldedAddresses', {})) as { shieldedAddress: string };
      return build(async () => ((await call('makeTransfer', {
        desiredOutputs: [{ kind: 'shielded', type: leg.token, value: leg.amount, recipient: shieldedAddress }],
        options: { payFees: true },
      })) as { tx: string }).tx);
    },
    async takeOffer(tx) {
      if (closed) throw new Error('The wallet session is closed');
      return build(() => reported(() => current.connector.takeOffer(SESSION_CONNECTION, tx)));
    },
    async cancelOffers(offers) {
      if (closed) throw new Error('The wallet session is closed');
      return build(() => reported(() => current.connector.cancelOffers(SESSION_CONNECTION, offers)));
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
      await current.connector.revertPendingTxs(SESSION_CONNECTION).catch(() => { /* best-effort: the wallet is stopping */ });
      await current.stop();
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
  /** The state root the wallet's config and caches live under. */
  root: string;
  /** Where the wallet's lines for the person go (a cache it can't restore from, the connector's waits for Dust). */
  notice: NoticeSink;
  /** The engines of the host the session opens in: the network's SDK set is loaded from them. */
  engines: HostEngines;
  /** The network's endpoints; when absent, as a command without endpoint flags resolves them (the saved config, then the defaults). */
  networkConfig?: NetworkConfig;
  /** The host's settings, read only to resolve the endpoints when `networkConfig` is absent (local stack detection, the Blockfrost ids); every one unset when not given. */
  settings?: NetworkSettings;
  /** Whether to sync the shielded wallet; off where the network has no shielded faucet, unless forced. */
  forceShielded?: boolean;
  /** How long to wait for the wallet's Dust once synced, in milliseconds; the connector's default when absent. */
  dustWaitMs?: number;
  /** Cancels the open: what was started is stopped. */
  signal?: AbortSignal;
  /** What the open is doing now, for a progress line; with `sdkWarnings`, also the SDK's transient warnings, as `SDK: <message>`. */
  onMessage?: (message: string) => void;
  /**
   * Where the SDK's transient warnings go (a call's, from the host's process
   * guard): the session listens from the open until close(), so the guard
   * hands them to it rather than reporting or exiting.
   */
  sdkWarnings?: CallSdkWarnings;
}

/**
 * Opens a seed's wallet on a network: synced, its Dust ready, with the
 * network's engine from `options.engines`. With `sdkWarnings`, the session
 * listens for the SDK's transient warnings from the open until close().
 */
export async function openWalletSession(options: OpenWalletSessionOptions): Promise<WalletSession> {
  const { signal, onMessage } = options;
  throwIfCancelled(signal);
  const stopListening = options.sdkWarnings?.listen(onMessage === undefined ? undefined : (_tag, message) => onMessage(`SDK: ${message}`)) ?? (() => {});
  try {
    const session = await openSession(options);
    return {
      ...session,
      async close() {
        try {
          await session.close();
        } finally {
          stopListening();
        }
      },
    };
  } catch (err) {
    stopListening();
    throw err;
  }
}

async function openSession(options: OpenWalletSessionOptions): Promise<WalletSession> {
  const { seed, network, root, signal } = options;
  const networkConfig = options.networkConfig
    ?? resolveNetwork({ args: { command: 'wallet-session', subcommand: '', positionals: [], flags: { network } }, configDir: root }, options.settings ?? settingsFromEnvironment({})).config;
  const engine = await options.engines.load(sdkSetOf(network, root));
  const open = () => engine.wallet.openConnector({
    seed,
    root,
    notice: options.notice,
    network,
    networkConfig,
    address: engine.keys.unshieldedAddress(seed, network),
    syncMode: shieldedSyncEnabled(network, options.forceShielded) ? 'full' : 'lite',
    dustWaitMs: options.dustWaitMs,
    signal,
    onMessage: options.onMessage ?? (() => {}),
  });
  return sessionOver(network, await open(), (tx, stage) => engine.ledger.readTransaction(tx, stage), { reopen: open, onMessage: options.onMessage });
}
