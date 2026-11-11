// The Midnight SDK, behind one interface. Everything that touches an SDK set
// is an engine's; the rest of mn reaches it through the engine for its
// network, and names no SDK type. Which engine there is is the host's: its
// engine loader makes each host an engine of its own (the shell's loader, the
// engine it ships). Loading an engine loads its SDK, so the loader imports it
// only when asked.

import type { OfferContents } from './swap-offer.ts';
import type { OpenOffer } from './open-offers.ts';
import type { NetworkConfig, NetworkName } from './network.ts';
import type { CallSdkWarnings } from './sdk-warnings.ts';
import type { VerboseLog } from './verbose.ts';
import type { ApprovalOptions } from './approval.ts';
import type { NoticeSink, WaitSink } from './notices.ts';
import type { FeeLimits } from './fee-limits.ts';
import type { RpcHandler } from './connector-api.ts';
import type { Spinner } from '../ui/spinner.ts';
import type { Host } from './host.ts';

/** The SDK set mn runs on: the SDK's release candidates. */
export type SdkSet = 'rc';

/** A wallet's keys and addresses, derived from its seed. Every set derives the same ones. */
export interface EngineKeys {
  /** The unshielded address of the seed's key at `keyIndex` (default 0) on a network. */
  unshieldedAddress(seed: Buffer, network: NetworkName, keyIndex?: number): string;
  /** The first unshielded address on every network. */
  unshieldedAddresses(seed: Buffer, keyIndex?: number): Record<NetworkName, string>;
  /** The shielded address on a network. */
  shieldedAddress(seed: Buffer, network: NetworkName): string;
  /** The shielded address on every network. */
  shieldedAddresses(seed: Buffer): Record<NetworkName, string>;
  /** The Dust public key, hex: what the Dust reader's cache is named by. */
  dustPublicKeyHex(seed: Buffer): string;
  /** The shielded coin public key, hex: what the shielded reader's cache is named by. */
  shieldedCoinPublicKeyHex(seed: Buffer): string;
  /** Throws, saying why, unless `address` is a bech32m address of that kind on `network`. */
  assertAddress(address: string, kind: 'shielded' | 'unshielded', network: NetworkName): void;
}

/** A line of what a transaction is, as an approval prompt shows it. */
export interface TransactionDetail {
  label: string;
  value: string;
}

/** A chain's block limits: time in picoseconds, the rest in bytes. */
export interface BlockLimits {
  readTime: number;
  computeTime: number;
  blockUsage: number;
  bytesWritten: number;
  bytesChurned: number;
}

/** What an engine reads from the ledger's serialized values. */
export interface EngineLedger {
  /** The block limits in serialized ledger parameters (hex), as the indexer serves them. Throws when the bytes aren't this set's ledger parameters. */
  blockLimits(parametersHex: string): BlockLimits;
  /** The most the fee prices can rise in one block, as a factor (1.046 for 4.6%), in serialized ledger parameters (hex). Throws when the bytes aren't this set's ledger parameters. */
  maxPriceAdjustment(parametersHex: string): number;
  /** The raw id of the unshielded NIGHT token, as wallet balances are keyed. */
  nightTokenId(): string;
  /** What a serialized transaction (hex) is, as an approval prompt shows it; never throws. */
  readTransaction(txHex: string, stage: 'unsealed' | 'sealed'): TransactionDetail[];
  /** What a swap offer (a sealed transaction, hex) gives and wants, and the coins it spends, from its bytes alone. Throws NotAnOfferError for anything else. */
  readOffer(txHex: string): OfferContents;
  /** The nullifiers of the shielded coins a transaction (hex, sealed or not) spends. Throws when the bytes aren't a ledger-9 transaction. */
  spentNullifiers(txHex: string): string[];
}

/** A contract's ledger state read without its compiled contract: cells as their field-aligned bytes in hex, maps by size. */
export type RawStateValue =
  | { type: 'null' }
  | { type: 'cell'; value: string[] }
  | { type: 'array'; items: RawStateValue[] }
  | { type: 'map'; size: number }
  | { type: 'boundedMerkleTree'; height: number; root: string[] | null };

/** What every SDK set's contract script shares, which the contract runner gives the engine. */
export interface ScriptParts {
  /** First in every script: reports a failure as one marked line. */
  readonly prelude: string;
  /** The client of mn serve's RPC on that port, defining rpcConnect, rpcCall and rpcClose. */
  rpcClientCode(servePort: number): string;
  /** Defines coerceArg, which turns a JSON argument into a circuit's runtime value. */
  readonly coerceArgFn: string;
  /** Defines resolvePrivateStateSecretKey. */
  readonly privateStateSecretFn: string;
  /** Defines openPrivateStateStore, which a deploy or call script opens the private-state store with first. */
  readonly privateStateStoreFn: string;
  /** The environment variables carrying the private-state secret, the store's password and its account, which never go into a script's text. */
  readonly privateStateSecretEnv: string;
  readonly privateStatePasswordEnv: string;
  readonly privateStateAccountEnv: string;
  /** The environment variable naming the private-state store's folder (absolute), under mn's state root. */
  readonly privateStateDirEnv: string;
  /** Defines waitForPrivateState, which a script wraps its level providers in so that an operation waits while another process holds the store, and privateStateBusyText, what such a wait says. */
  readonly privateStateWaitFn: string;
  /** How a wait for the store names the private state of the contract at `address` (undefined for a deploy). */
  privateStateName(address: string | undefined): string;
  /** How long one private-state operation waits for the store before failing with CONTRACT_STATE_BUSY. */
  readonly privateStateBusyWaitMs: number;
  /** Marks a line a script writes for mn's notices (JSON text after it), apart from its progress lines. */
  readonly noticeMarker: string;
  /** Marks the line a deploy or call script writes with the price mn serve gave its transaction before proving (JSON text after it). */
  readonly pricedMarker: string;
  /** The environment variable that, set to `1`, stops a deploy or call script once its transaction is priced: nothing is proven or sent. */
  readonly dryRunEnv: string;
  /** Where the dApp's witnesses may be, relative to its folder. */
  readonly witnessCandidates: readonly string[];
  /** The environment variables carrying the indexer's URLs, which never go into a script's text. */
  readonly indexerUrlEnv: string;
  readonly indexerWsUrlEnv: string;
  /**
   * Defines readContractArgsFile(fs, path), which reads a deploy's or call's
   * arguments (a JSON array) from the file `path` names and deletes it: the
   * arguments never go into a script's text or argv.
   */
  readonly contractArgsFn: string;
  /**
   * Defines callPrivateStateOptions(states, privateStateId, seed), the
   * private-state options of a call's findDeployedContract: the seeded
   * initialPrivateState only when the contract's store holds none, so a call
   * starts from the state the last call's witnesses left.
   */
  readonly callPrivateStateFn: string;
  /** The environment variable naming a deploy's or call's arguments file (a 0600 file under mn's state root). */
  readonly contractArgsFileEnv: string;
  /** The private-state key a call script records the coins a call gave the contract under, by nonce (hex): `{ nonce, color, value, mt_index }`. */
  readonly heldCoinsKey: string;
}

/** A compiled contract, as the scripts load it. */
export interface ScriptContract {
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
}

/** A deploy script: its arguments come through the arguments file (ScriptParts.contractArgsFileEnv), never its text. */
export interface DeployScript extends ScriptContract {
  servePort: number;
  privateStateKey?: string;
}

/** A call script: its arguments come through the arguments file (ScriptParts.contractArgsFileEnv), never its text. */
export interface CallScript extends ScriptContract {
  servePort: number;
  contractAddress: string;
  circuit: string;
  privateStateKey?: string;
  /** The circuit's ShieldedCoinInfo arguments (place and name): the coins a call may give the contract, recorded under ScriptParts.heldCoinsKey once it lands. */
  heldCoinArguments?: readonly { index: number; name: string }[];
}

export interface StateScript extends ScriptContract {
  contractAddress: string;
}

/** The scripts mn runs in a dApp's folder, and the packages they import, for one SDK set. */
export interface EngineContractScripts {
  /** Every package a script imports, and the compact runtime a compiled contract imports. */
  readonly packages: readonly string[];
  /** The folder of one of them as this engine's install has it; null when it isn't installed. */
  packageFolder(name: string): string | null;
  /** The compact runtime this engine runs contracts on. */
  readonly compactRuntimeVersion: string;
  /** The compiler whose contracts that runtime runs, as a person would ask for it: `compactc 0.36`. */
  readonly compiler: string;
  /** Whether this engine's compact runtime runs a contract compiled for `runtimeVersion` (the runtime's own rule). */
  acceptsRuntime(runtimeVersion: string): boolean;
  deploy(script: DeployScript, parts: ScriptParts): string;
  call(script: CallScript, parts: ScriptParts): string;
  state(script: StateScript, parts: ScriptParts): string;
}

/** What an engine does with contracts in mn's own process. */
export interface EngineContracts {
  /** A deployed contract's raw ledger state from the indexer; null when no contract is at `address`. */
  rawState(networkConfig: NetworkConfig, address: string): Promise<RawStateValue | null>;
  /** Whether midnight-js accepts a private-state password (its own policy, which a random draw can miss). */
  acceptsPrivateStatePassword(password: string): boolean;
  /** The scripts the contract runner runs in a dApp's folder. */
  readonly scripts: EngineContractScripts;
}

/** A wallet's shielded balances, from mn's own reader of the indexer's events. */
export interface ShieldedBalanceResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable NIGHT coins. */
  availableCoins: number;
  /** Shielded tokens other than NIGHT, by raw type (sorted), with their balances. */
  tokens: ReadonlyMap<string, bigint>;
  /** Events applied in this run (delta since last cache save). */
  eventCount: number;
  /** Latest event id in the saved cache (carried from prior cache if no new events). */
  lastAppliedEventId: number;
  /** True if an existing cache was loaded and extended; false if synced from scratch. */
  fromCache: boolean;
  /** True if the sync stopped before catching up (timeout/abort) — resume next call. */
  partial: boolean;
}

export interface ShieldedCachedOptions {
  /** Called with (eventsApplied, maxIdSeen) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  /** Stops the read; what was applied is kept for the next. */
  signal?: AbortSignal;
  /** Soft ceiling for the whole read, after which it returns what it has (partial). */
  timeoutMs?: number;
  /** Ignore any cached state and re-sync from the beginning (honours --no-cache). */
  forceFresh?: boolean;
  /** Current chain genesis hash — stored on save and checked on load (chain-reset guard). */
  chainId?: string;
  /**
   * The chain tip's protocol version, read before the events; null or absent
   * when unknown. On a chain that forked from ledger 8, a read caught up past
   * the fork ends on ledger 9 even when no zswap event after the fork exists yet.
   */
  chainProtocolVersion?: bigint | null;
  /** The state root the cache lives under. */
  root: string;
}

/** mn's own readers of a wallet's chain state, beside the SDK's wallet. */
export interface EngineReaders {
  /** The shielded NIGHT balance of a seed on a network, reading (and extending) its cache. */
  shieldedBalance(seed: Buffer, network: NetworkName, indexerWS: string, options: ShieldedCachedOptions): Promise<ShieldedBalanceResult>;
}

// ── The wallet ──

/** An address's unshielded balances, as the indexer's UTXOs give them. */
export interface BalanceSummary {
  balances: Map<string, bigint>;
  utxoCount: number;
  txCount: number;
  highestTxId: number;
  /** Count of unspent native-token UTXOs registered for dust generation. */
  registeredUtxos: number;
  /** Count of unspent native-token UTXOs NOT registered for dust generation. */
  unregisteredUtxos: number;
}

/** One more payment in the same transaction: an output of `amount` to `address`. */
export interface TransferRecipient {
  /** The recipient's address on the network, of the kind the transfer sends (unshielded or shielded). */
  address: string;
  /** In NIGHT's smallest unit; more than 0. */
  amount: bigint;
}

export interface TransferParams {
  seedBuffer: Buffer;
  networkConfig: NetworkConfig;
  recipientAddress: string;
  /** In NIGHT's smallest unit; more than 0. */
  amount: bigint;
  /** Further recipients paid in the same transaction after `recipientAddress`, one output each; none: only `recipientAddress` is paid. */
  extraRecipients?: readonly TransferRecipient[];
  signal?: AbortSignal;
  onSync?: (applied: number, highest: number) => void;
  onSyncDetail?: (walletsStillSyncing: string) => void;
  onDust?: (status: string) => void;
  onProving?: () => void;
  onSubmitting?: () => void;
  /** Fires every second while waiting for chain finalization. `elapsedMs`
   * is the time since the submit started. Use to drive an elapsed-time
   * display so users see the wait is alive.
   */
  onSubmittingTick?: (elapsedMs: number) => void;
  onSyncWarning?: (tag: string, message: string) => void;
  /** The call's SDK warnings, listened to for the whole transfer. */
  sdkWarnings: CallSdkWarnings;
  /** The call's verbose lines. */
  log?: VerboseLog;
  /** The state root the wallet's caches live under. */
  root: string;
  /** Where its lines for the person go (the host's notices). */
  notice: NoticeSink;
}

export interface TransferResult {
  txHash: string;
  /** What the transaction pays, all its recipients together. */
  amountMicroNight: bigint;
}

export interface EnsureDustResult {
  alreadyAvailable: boolean;
  txHash?: string;
}

export type AirdropParams = Omit<TransferParams, 'seedBuffer' | 'extraRecipients'>;

export interface DustRegisterOptions {
  signal?: AbortSignal;
  /** What the registration is doing now, for a progress line. */
  onStatus?: (status: string) => void;
  /** Wallet sync progress, as blocks applied of the highest seen. */
  onSyncProgress?: (applied: number, highest: number) => void;
  /** Which wallets the sync still waits on. */
  onSyncDetail?: (detail: string) => void;
  /** A transient SDK error the sync is retrying past. */
  onSyncWarning?: (tag: string, message: string) => void;
  /** The call's SDK warnings, listened to for the whole registration. */
  sdkWarnings: CallSdkWarnings;
  /** The call's verbose lines. */
  log?: VerboseLog;
  /** The state root the wallet's caches live under. */
  root: string;
  /** Where its lines for the person go (the host's notices). */
  notice: NoticeSink;
}

export interface DustRegistration {
  /** The wallet had Dust already; nothing was registered. */
  alreadyAvailable: boolean;
  txHash?: string;
  /** The Dust balance once synced, in its smallest unit. */
  dustBalance: bigint;
}

export interface DustExportResult {
  network: string;
  /** Dust public key (hex) this snapshot belongs to — derived from the seed. */
  dustPublicKey: string;
  /** Last dust event id the snapshot covers; -1 if the wallet has no dust events yet. */
  offset: number;
  /** Dust balance encoded in the snapshot, at export time. */
  balance: bigint;
  /** Dust events applied during this export's sync (delta since any prior cache). */
  eventCount: number;
  /** True if an existing dust-direct cache was extended; false if synced from scratch. */
  fromCache: boolean;
  /**
   * True iff the sync stopped short of the chain tip. The snapshot is still a
   * valid checkpoint — restoring it is strictly better than starting cold — but
   * it is NOT current, and a wallet restored from it still has events to catch
   * up on. Consumers must not treat a partial export as a warm wallet.
   */
  partial: boolean;
  /** The facade-restorable dust snapshot — pass as `dustSerializedState`. */
  snapshot: string;
}

export interface UnshieldedView extends BalanceSummary {
  fromCache: boolean;
  fetchedAt: number;
}

export interface ReadOptions {
  /** Bypass every cache layer and re-fetch from network. */
  forceFresh?: boolean;
  signal?: AbortSignal;
  /** Status hook for spinner wiring. */
  onStatus?: (s: string) => void;
  /**
   * Raw progress signal during the underlying network fetch. For dust this
   * fires per-chunk (events applied vs max event id); for unshielded it
   * fires per-UTXO-batch (current tx vs highest tx id). Callers that already
   * have a spinner usually use this to render a percentage.
   */
  onProgress?: (current: number, highest: number) => void;
  /** The call's verbose lines. */
  log?: VerboseLog;
}

/** A read that keeps its cache under a state root. */
export interface CachedReadOptions extends ReadOptions {
  /** The state root the cache lives under. */
  root: string;
  /** Where its lines for the person go (the host's notices). */
  notice: NoticeSink;
}

/** A wallet's Dust, as mn's reader found it. */
export interface DustBalance {
  balance: bigint;
  availableCoins: number;
  ownedUtxoCount: number;
  syncTime: Date;
  /**
   * True iff any cache layer participated — either an in-memory memo hit, OR a
   * disk-cache resume (delta sync from a previous checkpoint). False only for
   * a true cold scan from event 0.
   */
  fromCache: boolean;
  /** Number of events applied by this call (0 on memo hits; delta count on disk-resume; full count on cold). */
  eventsApplied: number;
  /**
   * Id of the last dust event folded into `state`; -1 when the wallet has no
   * dust events on this chain yet. This is the snapshot offset a restoring
   * wallet resumes from, and it lives nowhere else in the view.
   */
  lastAppliedEventId: number;
  /**
   * True iff the sync stopped short of the chain tip even after exhausting the
   * partial-resume loop — the state is a valid checkpoint but NOT current.
   * Callers that hand this state to another wallet (`dust export`) must surface
   * it: restoring a short state looks like success and then silently falls back
   * to the SDK's cold sync for the remaining events.
   */
  partial: boolean;
  /** Wall-clock millis when this value was last refreshed from the network. */
  fetchedAt: number;
}

/** What a wallet operation reports while it syncs the wallet. */
export interface WalletSyncHooks {
  signal?: AbortSignal;
  log?: VerboseLog;
  onStatus?: (status: string) => void;
  onSyncProgress?: (applied: number, highest: number) => void;
  onSyncDetail?: (detail: string) => void;
}

/** A shielded payment of NIGHT from a seed's wallet. */
export interface ShieldedTransferParams extends WalletSyncHooks {
  seed: Buffer;
  /** The state root the wallet's caches and open offers live under. */
  root: string;
  /** Where its lines for the person go (the host's notices). */
  notice: NoticeSink;
  network: NetworkName;
  networkConfig: NetworkConfig;
  /** The recipient's shielded address on `network`. */
  recipient: string;
  /** In NIGHT's smallest unit. */
  amount: bigint;
  /** Further recipients paid in the same transaction after `recipient`, each at a shielded address on `network`, one output each. */
  extraRecipients?: readonly TransferRecipient[];
  /** Says each step, and the time the submit has taken. */
  progress: Spinner;
  /** The message of the InsufficientBalanceError thrown when the wallet holds less shielded NIGHT than it pays (`amount` and every extra recipient's), given what it holds, in NIGHT. */
  insufficient: (availableNight: string) => string;
  /** Right after another payment the wallet's Dust can be short of this fee: wait when the rest is moments away. */
  waitForDustToCover: boolean;
  /** The paying wallet's own shielded address, once synced. */
  onSenderShieldedAddress?: (address: string) => void;
}

/** A wallet a test's preparation checks, by its seed and its saved address. */
export interface PrepWallet {
  seed: Buffer;
  /** The state root the wallet's caches live under. */
  root: string;
  /** Where its lines for the person go (the host's notices). */
  notice: NoticeSink;
  network: NetworkName;
  networkConfig: NetworkConfig;
  address: string;
  signal?: AbortSignal;
  onMessage: (message: string) => void;
}

export interface DAppConnectorCallbacks {
  onPhaseStart?: (connectionId: string, method: string, phase: string) => void;
  onPhaseComplete?: (connectionId: string, method: string, phase: string, durationMs: number) => void;
}

/** A wallet's DApp connector: the API's methods as RPC handlers. */
export interface DAppConnector {
  handlers: Record<string, RpcHandler>;
  /** Revert all pending (unsubmitted) transactions for a connection, releasing locked coins. */
  revertPendingTxs(connectionId: string): Promise<void>;
  /** Stop tracking a built transaction as this connection's (a swap offer handed to a taker): it is never reverted. False when the connection holds no such transaction. */
  handOffPendingTx(connectionId: string, txHex: string): boolean;
  /** Takes a swap offer (sealed, hex): validates it before building, adds this wallet's half and the fee, validates the whole, and holds it pending for the connection; the swap, sealed, hex. The terms and liveness are the caller's to check first. */
  takeOffer(connectionId: string, txHex: string): Promise<string>;
  /** Cancels open swap offers of this wallet's by spending their coins back to itself; the cancel, sealed, hex, pending until submitted. Refused when it wouldn't spend every coin of every offer. */
  cancelOffers(connectionId: string, offers: readonly OpenOffer[]): Promise<string>;
  /** Whether the wallet holds, unspent and in none of its open swap offers, a shielded coin of `token` worth exactly `amount`. */
  holdsFreeCoin(token: string, amount: bigint): boolean;
  /** True if any connection has a balanced-but-not-submitted transaction. */
  hasPendingTxs(): boolean;
  dispose(): void;
}

/** The connector over a synced wallet, in --approve-all mode, for a command of mn's own; stop() stops both. */
export interface OpenedConnector {
  connector: DAppConnector;
  stop(): Promise<void>;
}

/** A wallet synced for mn serve, while the serve runs. */
export interface ServedWalletSession {
  /** Waits for the wallet's Dust coins to be available (on preprod 10 to 30 s after a sync); whether they are. */
  waitForDust(): Promise<boolean>;
  /** Saves the wallet's state for the next start; best-effort. */
  saveState(): Promise<void>;
  /** The DApp connector over the wallet, reading from the state the last wait ended on. */
  connect(options: { approvalOptions: ApprovalOptions; feeLimits?: FeeLimits; callbacks?: DAppConnectorCallbacks }): DAppConnector;
}

/** A wallet, through the SDK's wallet and mn's readers. */
export interface EngineWallet {
  /** The unshielded balance of an address, through mn's cache. */
  unshieldedBalance(address: string, networkConfig: NetworkConfig, options?: ReadOptions): Promise<UnshieldedView>;
  /** A seed's Dust, through mn's reader and its cache. */
  dustBalance(seed: Buffer, networkConfig: NetworkConfig, options: CachedReadOptions): Promise<DustBalance>;
  /** An unshielded payment of NIGHT. */
  transfer(params: TransferParams): Promise<TransferResult>;
  /** NIGHT from the genesis wallet (a local chain only). */
  airdrop(params: AirdropParams): Promise<TransferResult>;
  /** A shielded payment of NIGHT; its transaction hash. */
  shieldedTransfer(params: ShieldedTransferParams): Promise<string>;
  /** Registers a seed's NIGHT for Dust, unless it has Dust already. */
  registerDust(seed: Buffer, networkConfig: NetworkConfig, options: DustRegisterOptions): Promise<DustRegistration>;
  /** A seed's Dust as a snapshot another wallet restores from. */
  exportDust(seed: Buffer, network: string, networkConfig: NetworkConfig, options: { root: string; notice: NoticeSink; signal?: AbortSignal; log?: VerboseLog; onProgress?: (eventsApplied: number, maxIdSeen: number) => void }): Promise<DustExportResult>;
  /** A test wallet's unshielded NIGHT after a quick sync; its state is saved when it holds some. */
  prepNightBalance(wallet: PrepWallet): Promise<bigint>;
  /** Makes sure a test wallet has Dust, registering and then waiting up to `waitMs` for it. */
  prepDust(wallet: PrepWallet, waitMs: number): Promise<{ alreadyAvailable: boolean; dustAvailable: boolean }>;
  /** The connector over a seed's wallet, synced and its Dust ready, for a command of mn's own. */
  openConnector(options: { seed: Buffer; root: string; notice: NoticeSink; waiting?: WaitSink; network: NetworkName; networkConfig: NetworkConfig; address: string; syncMode: 'full' | 'lite'; dustWaitMs?: number; signal?: AbortSignal; onMessage: (message: string) => void }): Promise<OpenedConnector>;
  /** Syncs a seed's wallet strictly for mn serve and runs `serve` with it; the wallet stops when `serve` ends. */
  serveWallet<T>(options: { seed: Buffer; root: string; notice: NoticeSink; waiting?: WaitSink; networkConfig: NetworkConfig; network: NetworkName; address: string; syncMode: 'full' | 'lite' } & WalletSyncHooks, serve: (session: ServedWalletSession) => Promise<T>): Promise<T>;
}

/** The entry points of the account package (@kuiralabs/midnight-account-chain) an engine loads, by their subpath. */
export type AccountEntryPoint = 'artefacts' | 'connector' | 'context' | 'contract' | 'deposit' | 'errors' | 'owner';

/**
 * The account package's entry points as an engine loaded them, each a module
 * namespace. Core names none of the package's types: grant, which drives the
 * package, types the modules it takes from here.
 */
export type EngineAccountPackage = Readonly<Record<AccountEntryPoint, unknown>>;

/** One SDK set, as mn uses it. */
export interface Engine {
  readonly set: SdkSet;
  readonly keys: EngineKeys;
  readonly ledger: EngineLedger;
  readonly contracts: EngineContracts;
  readonly readers: EngineReaders;
  readonly wallet: EngineWallet;
  /**
   * The account package as this engine installs it: the copy whose peer
   * dependencies resolve to this engine's SDK set, so it runs the contract
   * build for that set. Loaded on first ask; an engine loads without it.
   */
  account(): Promise<EngineAccountPackage>;
}

/** The SDK set a network runs on: every network runs on the rc set. */
export function sdkSetOf(network: NetworkName, root: string): SdkSet {
  return 'rc';
}

/** What an engine takes from the host that loads it: its settings, and where its notices go. */
export type EngineHost = Pick<Host, 'settings' | 'notice'>;

/** Makes the engine for an SDK set, for the host that asks: the program's, which knows the engines it ships. */
export type EngineLoader = (set: SdkSet, host: Host) => Promise<Engine>;

/** A host's engines: one engine of the host's own, loaded on first use. */
export interface HostEngines {
  /** The engine for an SDK set. */
  load(set: SdkSet): Promise<Engine>;
  /** The engine for a network's SDK set. */
  for(network: NetworkName): Promise<Engine>;
  /**
   * An engine for work every set does alike, such as deriving addresses: the
   * one the host has loaded, else the set of the network the call is for (the
   * rc set's when none was said).
   */
  any(): Promise<Engine>;
  /** The network a call is for, whose set any() loads while the host has loaded none. */
  prefer(network: NetworkName): void;
}
