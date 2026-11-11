// Genesis wallet seed (seed 0x01) — used for local devnet funding
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

// Native NIGHT token type (all zeros, 32 bytes hex)
export const NATIVE_TOKEN_TYPE = '0000000000000000000000000000000000000000000000000000000000000000';

// Midnight indexer GraphQL API version. Single source of truth — anything
// that builds an indexer URL (per-network defaults, testcontainer overrides,
// help examples, healthchecks) reads from these. Bumping the version here
// flows everywhere.
export const INDEXER_API_VERSION = 'v4';
export const INDEXER_GRAPHQL_PATH = `/api/${INDEXER_API_VERSION}/graphql`;
export const INDEXER_GRAPHQL_WS_PATH = `/api/${INDEXER_API_VERSION}/graphql/ws`;

// The proof server image mn proves with: the one `midnight localnet up` runs,
// and the one a hosted network's user starts on their own machine.
export const PROOF_SERVER_IMAGE = 'midnightntwrk/proof-server:9.0.0';
/** The command that starts a local proof server on its default port. */
export const PROOF_SERVER_DOCKER_RUN = `docker run -p 6300:6300 ${PROOF_SERVER_IMAGE} midnight-proof-server -v`;

// NIGHT has 6 decimal places (1 NIGHT = 1_000_000 micro-NIGHT)
export const TOKEN_DECIMALS = 6;
export const TOKEN_MULTIPLIER = 1_000_000;

// What the wallet SDK pays a fee with: feesWithMargin(params, DUST_FEE_BLOCKS_MARGIN)
// + DUST_COST_OVERHEAD, priced before proving. The whole amount is burned, not
// only the fee the chain charges, so every margin block is Dust spent.
//
// No overhead: the price before proving is within 0.072% of the proven
// transaction's fee (a deploy, the worst measured; a transfer 0.013%; a call's
// is 2.5% above, as its proof is estimated at 4832 bytes). The 0.3 DUST mn
// added before covered that gap 400 times over, and cost 55% of a transfer's fee.
//
// Three blocks of margin: each block of margin prices at the highest price the
// chain can reach one block later (prices rise at most 4.6% a block, when
// blocks are full), and a transaction lands 3 to 4 blocks after the block it
// was priced at. Measured on a ledger-9 local chain, 2026-11-08. When the node
// still refuses the fee as too low, the paying paths price again with more
// margin (DUST_FEE_MARGIN_STEPS).
export const DUST_COST_OVERHEAD = 0n;
export const DUST_FEE_BLOCKS_MARGIN = 3;

// Minimum dust balance for a transfer transaction.
// We can't compute the exact fee without building the transaction; a 1 NIGHT
// unshielded transfer's fee was 0.548 DUST on a ledger-9 local chain
// (2026-11-08), and with 3 blocks of margin the wallet spends 0.627, so 0.65 DUST.
// Used as a pre-flight check: below it the transfer waits for Dust that is
// moments away, or fails fast with how long it takes. Measured on a local chain
// only; a transaction whose fee is higher (more inputs, other fee prices) is
// caught by the transfer retry, which waits for Dust to grow.
export const MIN_DUST_FOR_TRANSFER = 650_000_000_000_000n;

// Initial dust-accrual parameters (protocol constants, matching the ledger's
// INITIAL_PARAMETERS). Single source of truth: the direct dust readers build a
// `DustParameters` from these. The native sidecar (Rust) carries its own copy
// from the same midnight-ledger crate — keep them in sync if the protocol changes.
export const INITIAL_NIGHT_DUST_RATIO = 5_000_000_000n;
export const INITIAL_GENERATION_DECAY_RATE = 8_267n;
export const INITIAL_DUST_GRACE_PERIOD_SECONDS = 10_800n; // 3h (3 * 60 * 60)

// The NIGHT mn airdrops to a wallet its own local flows create: mn dev's
// wallets and the balance step mn test create writes. A wallet's Dust comes
// only from its registered NIGHT, at INITIAL_GENERATION_DECAY_RATE specks per
// STAR a second: 8,267 * 10^6 / 10^15 = 0.000008267 DUST per NIGHT a second
// (measured on a ledger-9 local chain on 2026-11-09: 100,000 NIGHT gained
// 0.8267 DUST a second). It counts from the airdrop's block, and registering
// carries what has accrued into the wallet's Dust.
//
// 50,000 NIGHT generates 0.41 DUST a second, 24.8 a minute:
// - the registration's 0.29 DUST fee, paid about 25 s after the airdrop, has
//   10 DUST behind it;
// - a counter deploy (1.08 DUST) is generated again in 2.6 s, a transfer
//   (0.55) in 1.3 s, a counter call (0.23 with the wallet's margin) in 0.6 s;
// - the first minute's 24.8 DUST covers a registration, a deploy and about
//   twenty calls or transfers.
// 1000 NIGHT, the amount before, generates 0.0083 DUST a second: mn test
// run's deploy waited 141 s and each call 4 to 11 s (a deploy and three calls
// took 316 s; with 50,000 NIGHT 136 s, with no wait). On a local chain the genesis wallet holds about 249
// million NIGHT, so this is 0.02% of it.
export const LOCAL_WALLET_FUNDING_NIGHT = 50_000;

// Timeouts (milliseconds)
export const SYNC_TIMEOUT_MS = 300_000;       // 5 minutes — full wallet sync (used by dust/balance commands)
export const SYNC_ATTEMPT_TIMEOUT_MS = 30_000;        // 30 seconds — per sync attempt on localnet
export const SYNC_ATTEMPT_REMOTE_TIMEOUT_MS = 120_000; // 120 seconds — per sync attempt on remote networks (preview/preprod)
export const PRE_SEND_SYNC_TIMEOUT_MS = 10_000; // 10 seconds — quick sync before tx
export const DUST_TIMEOUT_MS = 120_000;        // 2 minutes — wait for dust generation
export const PROOF_TIMEOUT_MS = 300_000;       // 5 minutes — ZK proof generation
export const BALANCE_CHECK_TIMEOUT_MS = 60_000; // 1 minute — GraphQL balance subscription

// Cold-sync heap headroom.
// The first (cold) shielded/dust sync against a hosted network streams the whole
// chain history through the wallet SDK. The live working set stays small (~300 MB),
// but the scan churns through a firehose of short-lived JS objects; under Node's
// default old-space cap (~4 GB) GC can't keep pace with the allocation rate and the
// process dies with "JavaScript heap out of memory" before it can finish — and write
// the cache that makes every later run cheap. Measured cold preprod shielded-sync
// high-water: ~8.4 GB. process/sync-heap.ts advises this headroom; mn's shell re-execs sync commands with it.
// Note: the cap must sit comfortably *above* the high-water, not just at it —
// crowding the limit makes V8 thrash on full GCs, which starves the sync loop
// and trips the per-attempt timeout. A 12 GB cap timed out; 16 GB completes.
export const SYNC_HEAP_TARGET_MB = 16384;   // 16 GB — proven headroom over the ~8.4 GB high-water
export const SYNC_HEAP_RAM_FRACTION = 0.7;  // never request more than 70% of physical RAM
export const SYNC_HEAP_MIN_GAIN_MB = 512;   // skip the re-exec if the headroom gain is smaller than this

// Transaction defaults
export const TX_TTL_MINUTES = 10;

// Retry configuration
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_000; // 1s, 2s, 4s (exponential)

// Dust registration retry — on a fresh localnet, the estimated dust generation
// may be less than the registration fee until enough time has passed since UTXO
// creation. The SDK computes allow_fee_payment = (currentTime - utxo.ctime) * rate,
// which starts near zero and grows over time. Observed ~5 minutes on fresh localnets.
export const DUST_REGISTRATION_TIMEOUT_MS = 600_000; // 10 minutes max for registration retries
export const DUST_REGISTRATION_RETRY_DELAY_MS = 15_000; // 15 seconds between retries

// Error codes from the node
export const STALE_UTXO_ERROR_CODE = 115;
export const BALANCE_OVERSPEND_ERROR_CODE = 138;

// Default storage directory
export const MIDNIGHT_DIR = '.midnight';
export const DEFAULT_WALLET_FILENAME = 'wallet.json';
export const DEFAULT_CONFIG_FILENAME = 'config.json';

// File system permissions (POSIX octal)
export const DIR_MODE = 0o700;   // owner rwx only — directories holding sensitive files
export const FILE_MODE = 0o600;  // owner rw only — wallet files containing seeds/keys

// Localnet directory name (under ~/.midnight/)
export const LOCALNET_DIR_NAME = 'localnet';

// Wallet state cache. v2: ledger-9 states replace ledger-8 ones. Dev-preset localnets share a genesis
// hash, so the chain-id guard can't keep a ledger-8 cache off a ledger-9 chain.
export const CACHE_VERSION = 2;
export const CACHE_DIR_NAME = 'cache';

// Multi-wallet support
export const WALLETS_DIR_NAME = 'wallets';
export const DEFAULT_WALLET_NAME = 'default';

/** The longest wallet name: its file name, and the folders named after it, stay well inside any filesystem's limit. */
export const MAX_WALLET_NAME_LENGTH = 64;

/**
 * Validate a wallet name (not a path).
 * Rejects empty strings, names longer than MAX_WALLET_NAME_LENGTH, path
 * separators, '.json' suffix, '..' traversal, and control characters.
 * Returns true if the name is safe.
 */
export function isValidWalletName(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  if ([...name].length > MAX_WALLET_NAME_LENGTH) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.endsWith('.json')) return false;
  if (name === '.' || name === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

// Dust retry — facade calls that consume dust may fail transiently after
// a rejection or sync hiccup. Retry with delay gives pending coins time
// to be released back to available.
export const DUST_RETRY_ATTEMPTS = 10;
export const DUST_RETRY_DELAY_MS = 3_000;

// Abandoned transaction timeout — if a DApp balances a tx but never submits
// (or disconnects uncleanly), auto-revert after this timeout to release
// pending dust coins. Shorter than the SDK's internal TX_TTL_MINUTES (10m).
export const ABANDONED_TX_TIMEOUT_MS = 120_000; // 2 minutes

// DApp Connector server port (99=midnight, 32=ws)
export const DEFAULT_SERVE_PORT = 9932;

// What every method mn serve answers beyond the DApp connector API's starts with.
export const MN_RPC_METHOD_PREFIX = 'mn_';
// mn serve's method that prices an unproven transaction (hex, `tx`) before it is proven (transaction-price.ts).
export const PRICE_TRANSACTION_METHOD = `${MN_RPC_METHOD_PREFIX}priceTransaction`;

// Dashboard URL — serves canary-verified status.json, compatibility.json, issues.json
export const DASHBOARD_BASE_URL = 'https://midnight-comp-tracker.vercel.app';
