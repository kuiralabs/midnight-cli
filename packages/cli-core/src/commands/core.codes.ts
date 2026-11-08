// The error codes core owns: those its base raises or more than one package
// does (arguments, the passphrase, networks and Blockfrost, cancellation, the
// SDK set and its layout, the Node.js version, the state root, the payer, a
// failed command), and those of the engine contract, which every engine
// raises (proofs, transactions, stale state, sync, Dust and balance, swap offers).
// Beside them, the sets of its codes a command definition declares (its
// errors.codes) by what the command does; scripts/code-reach.mjs holds each
// definition to what its modules can throw.

import { defineCodeSet, defineCodes } from '../lib/error-codes.ts';
import {
  EXIT_CANCELLED,
  EXIT_GENERAL_ERROR,
  EXIT_INSUFFICIENT_BALANCE,
  EXIT_INVALID_ARGS,
  EXIT_NETWORK_ERROR,
  EXIT_TX_REJECTED,
} from '../lib/exit-codes.ts';

export const coreCodes = defineCodes([
  { code: 'INVALID_ARGS', exitCode: EXIT_INVALID_ARGS, order: 10, summary: 'Missing/invalid argument.', recovery: 'Show the message to the user verbatim — it names the missing field.' },
  { code: 'WRONG_PASSPHRASE', exitCode: EXIT_INVALID_ARGS, order: 220, summary: "`MN_PASSPHRASE` is not the passphrase mn's secrets were encrypted with, or a sealed file was changed.", recovery: "Ask the user to correct `MN_PASSPHRASE` in the MCP server's environment. Nothing was changed." },
  { code: 'PASSPHRASE_REQUIRED', exitCode: EXIT_INVALID_ARGS, order: 230, summary: "A tool needed a secret (a wallet's seed, an account's owner key) and no passphrase could be had: `MN_PASSPHRASE` is unset and there is no terminal to ask at (the MCP server has none).", recovery: "Ask the user to set `MN_PASSPHRASE` in the MCP server's environment and restart it. Never ask them to type the passphrase into the chat." },
  { code: 'NETWORK_ERROR', exitCode: EXIT_NETWORK_ERROR, order: 30, summary: 'Indexer/node/proof-server connection refused or DNS failure.', recovery: 'Check `midnight_localnet_status()` (start it with `midnight_localnet_up()`) or the endpoints the user configured.' },
  { code: 'AMBIGUOUS_LOCAL_STACKS', exitCode: EXIT_NETWORK_ERROR, order: 180, summary: "Several local Midnight stacks are running and no endpoints are configured, so mn won't guess.", recovery: "Ask the user which stack to use; they set its endpoints with `midnight config set`. Don't retry blindly." },
  { code: 'BLOCKFROST_PROJECT_ID_REQUIRED', exitCode: EXIT_NETWORK_ERROR, order: 240, summary: 'The network (preprod or mainnet) is served by Blockfrost and no project id is set for it.', recovery: "Ask the user to create a Blockfrost project for that Midnight network at https://blockfrost.io (a preprod id starts with `nightpreprod`, a mainnet id with `nightmainnet`) and run `midnight config set blockfrost-project-id <project id>` themselves. Never ask them to paste the id into the chat. Don't retry until they have." },
  { code: 'BLOCKFROST_PROJECT_ID_REJECTED', exitCode: EXIT_NETWORK_ERROR, order: 250, summary: 'Blockfrost refused the project id (HTTP 403): mistyped, revoked, or for another network.', recovery: "Ask the user to check it at blockfrost.io and set it again. Don't retry blindly." },
  { code: 'BLOCKFROST_LIMIT_REACHED', exitCode: EXIT_NETWORK_ERROR, order: 260, summary: "Blockfrost's plan limit or rate limit.", recovery: 'Wait and retry once; if it persists, tell the user it is their Blockfrost plan.' },
  { code: 'ENDPOINT_SHUT_DOWN', exitCode: EXIT_NETWORK_ERROR, order: 270, summary: "An endpoint set by flag or config was shut down by its operator (the old preprod indexer, mainnet's old Midnight-hosted indexer and node).", recovery: '`midnight_config_unset({ key: "indexer-ws" })` (and `node` if set), then retry.' },
  { code: 'MAINNET_REFUSED', exitCode: EXIT_INVALID_ARGS, order: 275, summary: 'The command is refused on mainnet before anything runs: an airdrop (mainnet has no faucet), a test suite (it deploys throwaway contracts), or mn grant (no released account build there).', recovery: "Tell the user why (the message says) and don't retry on mainnet; offer undeployed or a test network instead." },
  { code: 'CANCELLED', exitCode: EXIT_CANCELLED, order: 370, summary: 'Operation was aborted (SIGINT, or the MCP call was cancelled).', recovery: "A transaction already submitted may still have landed: read the state first (`midnight_grant_status`, `midnight_balance`). Don't retry without confirming with the user." },
  { code: 'MIXED_SDK_LAYOUT', exitCode: EXIT_GENERAL_ERROR, order: 290, summary: "mn's packages were installed without the engine's shrinkwrap (bun's installer): the engine's SDK tree isn't the one it was tested with.", recovery: 'Ask the user to install mn with npm.' },
  { code: 'UNSUPPORTED_NODE', exitCode: EXIT_GENERAL_ERROR, order: 190, summary: 'Node.js is older than 22 (22.18 for mn grant).', recovery: 'Ask the user to install a current Node.js.' },
  { code: 'NO_STATE_ROOT', exitCode: EXIT_GENERAL_ERROR, order: 300, summary: "The host gave mn no place to keep its state (a program's `createHost` without paths).", recovery: "Give the host its paths (`createHost({ paths })`)." },
  { code: 'NO_PAYER', exitCode: EXIT_GENERAL_ERROR, order: 310, summary: 'A command that submits a transaction was called without a payer.', recovery: 'Give the call a payer.' },
  { code: 'COMMAND_FAILED', exitCode: EXIT_GENERAL_ERROR, order: 320, summary: 'A command ended with a non-zero exit code without throwing (an MCP test run whose tests failed); the message carries its result.', recovery: "Read the command's result in the message." },
  { code: 'UNKNOWN', exitCode: EXIT_GENERAL_ERROR, order: 380, summary: "Error didn't match any known classifier.", recovery: 'Surface the message to the user. If reproducible, a new code may be warranted.' },

  // The engine contract: what every engine raises.
  { code: 'PROOF_TIMEOUT', exitCode: EXIT_TX_REJECTED, order: 90, summary: "ZK proof generation didn't finish within the deadline.", recovery: 'Retry — proofs can be slow under load.' },
  { code: 'PROOF_FAILURE', exitCode: EXIT_TX_REJECTED, order: 100, summary: 'Proof server rejected or failed to generate the ZK proof. Often a stale commitment tree or unreachable proof server.', recovery: 'Check that the proof server is running (`midnight_localnet_status()`, or the endpoint the user configured); if it is, `midnight_cache_clear({ wallet: "<name>" })` then retry.' },
  { code: 'INVALID_DUST_PROOF', exitCode: EXIT_TX_REJECTED, order: 110, summary: 'Chain rejected the dust spend proof as malformed (substrate "Custom error 170"). Stale commitment tree.', recovery: '`midnight_cache_clear({ wallet: "<name>" })` then retry.' },
  { code: 'TX_REJECTED', exitCode: EXIT_TX_REJECTED, order: 60, summary: 'Chain rejected the submitted transaction (catch-all when no more specific code applies).', recovery: 'Read the message; usually a state mismatch resolved by re-sync + retry.' },
  { code: 'STALE_UTXO', exitCode: EXIT_TX_REJECTED, order: 70, summary: 'UTXO was already spent on-chain (substrate "error code 115").', recovery: 'Re-sync (the next call will refresh state) and retry.' },
  { code: 'STALE_CACHE', exitCode: EXIT_TX_REJECTED, order: 80, summary: 'Local wallet cache disagrees with chain (e.g. localnet reset, remote testnet re-indexed).', recovery: '`midnight_cache_clear({ wallet: "<name>" })` then retry.' },
  { code: 'SYNC_TIMEOUT', exitCode: EXIT_NETWORK_ERROR, order: 40, summary: 'Long-running wallet sync hit its deadline. Common on a hosted-network first-cold-sync.', recovery: 'Retry; the cache resumes from the last applied event so progress is preserved.' },
  { code: 'CONTRACT_STATE_UNREADABLE', exitCode: EXIT_GENERAL_ERROR, order: 114, summary: "A contract's state on chain can't be decoded by this mn's ledger: the state the chain holds is at fault, not the user's setup. The message names the contract and includes what the ledger said.", recovery: "Tell the user the contract's on-chain state is unreadable (show the message); don't retry, and don't suggest clearing caches or changing endpoints. Reading or calling that contract can't work until its state is fixed on chain." },
  { code: 'FEE_TOO_LOW', exitCode: EXIT_TX_REJECTED, order: 115, summary: 'The node refused the fee as too low even after mn priced it again with its largest margin (8 blocks of rising prices): prices are climbing faster than that, as when blocks are full one after another.', recovery: "Nothing was spent. Wait a minute and retry; don't retry in a loop." },
  { code: 'FEE_REPRICED', exitCode: EXIT_TX_REJECTED, order: 116, summary: "mn serve's node refused a transaction's fee as too low; mn serve now prices fees with more margin. The transaction keeps its old fee.", recovery: 'Balance the transaction again and submit it (`mn contract deploy` and `call` do this themselves). Nothing was spent.' },
  { code: 'DUST_REQUIRED', exitCode: EXIT_INSUFFICIENT_BALANCE, order: 120, summary: 'Wallet has NIGHT but not enough DUST for the fee.', recovery: 'Not registered (`midnight_dust_status()` shows `registered: false`): run `midnight_dust_register()`. Registered: its NIGHT is still generating the fee, which happens with time. mn has already waited when the fee was a few minutes away; the message says how long the rest takes ("generates the rest in about 4 minutes"). Wait that long and retry, don\'t retry at once.' },
  { code: 'DUST_GENERATING', exitCode: EXIT_INSUFFICIENT_BALANCE, order: 130, summary: "A Dust registration can't pay its fee yet: the wallet's NIGHT hasn't generated enough Dust.", recovery: 'The message says when: run `midnight_dust_register()` again then, or add NIGHT.' },
  { code: 'INSUFFICIENT_BALANCE', exitCode: EXIT_INSUFFICIENT_BALANCE, order: 50, summary: "Wallet doesn't have enough NIGHT to cover the requested amount.", recovery: 'Show the user. On localnet: `midnight_airdrop({ amount: "..." })`. On hosted networks: tell user to fund the address.' },
  { code: 'NOT_AN_OFFER', exitCode: EXIT_INVALID_ARGS, order: 330, summary: 'The bytes given as a swap offer are not one.', recovery: 'Ask the maker for the offer again.' },
  { code: 'TERMS_MISMATCH', exitCode: EXIT_INVALID_ARGS, order: 340, summary: "A swap offer's own terms differ from the agreed ones.", recovery: "Don't take it; agree the terms again with the maker." },
  { code: 'OFFER_EXPIRED', exitCode: EXIT_INVALID_ARGS, order: 350, summary: 'A swap offer is past the expiry its maker set.', recovery: 'Ask the maker for a new one.' },
  { code: 'OFFER_RECORD_UNREADABLE', exitCode: EXIT_GENERAL_ERROR, order: 365, summary: "mn's record of a wallet's open swap offers (`~/.midnight/swap-offers/<network>/<address>.json`) can't be read: not JSON, or not the shape mn writes.", recovery: 'Show the message: it names the file. Ask the user to restore it, or to move it aside (mn then forgets those offers). Don\'t retry until they have.' },
  { code: 'OFFER_COINS_IN_USE', exitCode: EXIT_INVALID_ARGS, order: 360, summary: "A spend would use coins an open swap offer of this wallet's holds, cancelling it.", recovery: 'Cancel the offer first (`mn swap cancel`), or wait until it is taken.' },
]);

/** What every command can end with, which no definition declares: the shell's usage and flag checks, cancellation, an error carrying no code, the Node.js version, the state root. */
export const EVERY_COMMAND = ['INVALID_ARGS', 'CANCELLED', 'UNKNOWN', 'UNSUPPORTED_NODE', 'NO_STATE_ROOT'] as const;

/** Resolving a network and its endpoints: several local stacks, Blockfrost's project id and limits, an endpoint shut down. */
export const RESOLVES_NETWORK = defineCodeSet('network', ['AMBIGUOUS_LOCAL_STACKS', 'BLOCKFROST_PROJECT_ID_REQUIRED', 'BLOCKFROST_PROJECT_ID_REJECTED', 'BLOCKFROST_LIMIT_REACHED', 'ENDPOINT_SHUT_DOWN']);

/** Asking the host for an engine: an install without its shrinkwrap. */
export const LOADS_ENGINE = defineCodeSet('engine', ['MIXED_SDK_LAYOUT']);

/** Syncing a wallet through an engine: a connection that failed, a sync past its deadline, a cache the chain no longer fits. */
export const ENGINE_SYNC = defineCodeSet('sync', ['NETWORK_ERROR', 'SYNC_TIMEOUT', 'STALE_CACHE']);

/** Paying for a transaction: the node's refusals, the proof, the Dust for the fee, the NIGHT, coins an open swap offer holds. */
export const PAYS = defineCodeSet('paying', ['TX_REJECTED', 'STALE_UTXO', 'INVALID_DUST_PROOF', 'FEE_TOO_LOW', 'FEE_REPRICED', 'PROOF_TIMEOUT', 'PROOF_FAILURE', 'DUST_REQUIRED', 'DUST_GENERATING', 'INSUFFICIENT_BALANCE', 'OFFER_COINS_IN_USE', 'OFFER_RECORD_UNREADABLE']);

/** Reading a swap offer's bytes and terms. */
export const READS_OFFERS = defineCodeSet('offers', ['NOT_AN_OFFER', 'TERMS_MISMATCH']);
