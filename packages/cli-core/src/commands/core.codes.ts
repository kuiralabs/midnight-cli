// The error codes core owns: those its base raises or more than one package
// does (arguments, the passphrase, networks and Blockfrost, cancellation, the
// SDK set and its layout, the Node.js version, the state root, the payer, a
// failed command), and those of the engine contract, which every engine
// raises (proofs, transactions, stale state, sync, Dust and balance, swap offers).

import { defineCodes } from '../lib/error-codes.ts';
import {
  EXIT_CANCELLED,
  EXIT_GENERAL_ERROR,
  EXIT_INSUFFICIENT_BALANCE,
  EXIT_INVALID_ARGS,
  EXIT_NETWORK_ERROR,
  EXIT_TX_REJECTED,
} from '../lib/exit-codes.ts';

export const coreCodes = defineCodes([
  { code: 'INVALID_ARGS', exitCode: EXIT_INVALID_ARGS, summary: 'Missing or invalid arguments.', recovery: 'Fix the arguments and run it again; `midnight help <command>` shows them.' },
  { code: 'WRONG_PASSPHRASE', exitCode: EXIT_INVALID_ARGS, summary: "mn's passphrase was wrong, or a sealed secret was changed.", recovery: 'Run it again with the passphrase mn was protected with.' },
  { code: 'PASSPHRASE_REQUIRED', exitCode: EXIT_INVALID_ARGS, summary: 'A secret was needed and no passphrase could be had.', recovery: 'Set MN_PASSPHRASE, or run at a terminal.' },
  { code: 'NETWORK_ERROR', exitCode: EXIT_NETWORK_ERROR, summary: 'Connection refused, timeout, DNS failure.', recovery: 'Check that the node, indexer and proof server at the configured endpoints are running.' },
  { code: 'AMBIGUOUS_LOCAL_STACKS', exitCode: EXIT_NETWORK_ERROR, summary: 'Several local Midnight stacks run and no endpoints were given.', recovery: 'Pass endpoint flags or `midnight config set` them.' },
  { code: 'BLOCKFROST_PROJECT_ID_REQUIRED', exitCode: EXIT_NETWORK_ERROR, summary: 'The network is served by Blockfrost and no project id is set.', recovery: '`mn config set blockfrost-project-id <project id>`.' },
  { code: 'BLOCKFROST_PROJECT_ID_REJECTED', exitCode: EXIT_NETWORK_ERROR, summary: 'Blockfrost refused the project id.', recovery: 'Check it at blockfrost.io and set it again.' },
  { code: 'BLOCKFROST_LIMIT_REACHED', exitCode: EXIT_NETWORK_ERROR, summary: "Blockfrost is holding the project back (its plan's daily limit, or too many requests at once).", recovery: "Wait, or see the project's plan." },
  { code: 'ENDPOINT_SHUT_DOWN', exitCode: EXIT_NETWORK_ERROR, summary: 'An endpoint set by flag or config was shut down by its operator.', recovery: 'Unset it (`mn config unset indexer-ws`).' },
  { code: 'CANCELLED', exitCode: EXIT_CANCELLED, summary: 'Operation cancelled (SIGINT).' },
  { code: 'OTHER_SDK_SET', exitCode: EXIT_GENERAL_ERROR, summary: "The process has loaded one SDK set's engine and the call's network runs on the other.", recovery: 'Run the call in a process of its own (for MCP, a server for that network).' },
  { code: 'MIXED_SDK_LAYOUT', exitCode: EXIT_GENERAL_ERROR, summary: "An engine's SDK packages reach more than one copy of its ledger: mn was installed without its shrinkwrap (bun's installer).", recovery: 'Install mn with npm.' },
  { code: 'UNSUPPORTED_NODE', exitCode: EXIT_GENERAL_ERROR, summary: 'This Node.js is older than mn supports (22).', recovery: 'Install a current Node.js.' },
  { code: 'NO_STATE_ROOT', exitCode: EXIT_GENERAL_ERROR, summary: 'The host gave mn no place to keep its state.', recovery: 'Give the host its paths (createHost paths).' },
  { code: 'NO_PAYER', exitCode: EXIT_GENERAL_ERROR, summary: 'A command that submits a transaction was called without a payer.', recovery: 'Give the call a payer.' },
  { code: 'COMMAND_FAILED', exitCode: EXIT_GENERAL_ERROR, summary: 'A command ended with a non-zero exit code without throwing (a test run whose tests failed); the message carries its result.', recovery: "Read the command's result in the message." },
  { code: 'UNKNOWN', exitCode: EXIT_GENERAL_ERROR, summary: 'Unclassified error.' },

  // The engine contract: what every engine raises.
  { code: 'PROOF_TIMEOUT', exitCode: EXIT_TX_REJECTED, summary: 'ZK proof generation timed out.', recovery: 'Retry: proofs can be slow under load.' },
  { code: 'PROOF_FAILURE', exitCode: EXIT_TX_REJECTED, summary: 'Proof server rejected or failed to generate the ZK proof.', recovery: 'Ensure the proof server is running, then retry; if persistent, `mn cache clear` to force a fresh sync.' },
  { code: 'INVALID_DUST_PROOF', exitCode: EXIT_TX_REJECTED, summary: 'Chain rejected the dust spend proof as malformed (substrate "Custom error 170").', recovery: '`mn cache clear --wallet <name>` then retry.' },
  { code: 'TX_REJECTED', exitCode: EXIT_TX_REJECTED, summary: 'Transaction rejected by the node.' },
  { code: 'STALE_UTXO', exitCode: EXIT_TX_REJECTED, summary: 'UTXOs consumed by another transaction (substrate "error code 115").', recovery: 'Re-sync (the next call refreshes the state) and retry.' },
  { code: 'STALE_CACHE', exitCode: EXIT_TX_REJECTED, summary: 'Local wallet cache disagrees with chain state (a localnet reset, a remote testnet re-index).', recovery: '`mn cache clear --wallet <name>` then retry.' },
  { code: 'SYNC_TIMEOUT', exitCode: EXIT_NETWORK_ERROR, summary: 'Wallet sync exceeded its deadline.', recovery: 'Retry: the cache resumes from the last applied event.' },
  { code: 'DUST_REQUIRED', exitCode: EXIT_INSUFFICIENT_BALANCE, summary: 'Not enough Dust for the fee.', recovery: 'Not registered: `mn dust register`. Generating: retry when the message says, or register more NIGHT.' },
  { code: 'DUST_GENERATING', exitCode: EXIT_INSUFFICIENT_BALANCE, summary: "A Dust registration can't pay its fee yet: the wallet's NIGHT hasn't generated enough Dust.", recovery: 'Run `mn dust register` again at the time the message gives, or add NIGHT.' },
  { code: 'INSUFFICIENT_BALANCE', exitCode: EXIT_INSUFFICIENT_BALANCE, summary: 'Not enough NIGHT for the operation.' },
  { code: 'NOT_AN_OFFER', exitCode: EXIT_INVALID_ARGS, summary: 'Bytes given as a swap offer are not one.', recovery: 'Ask the maker for the offer again.' },
  { code: 'TERMS_MISMATCH', exitCode: EXIT_INVALID_ARGS, summary: "A swap offer's own terms differ from the agreed ones.", recovery: "Don't take it; agree the terms again with the maker." },
  { code: 'OFFER_EXPIRED', exitCode: EXIT_INVALID_ARGS, summary: 'A swap offer is past the expiry its maker set.', recovery: 'Ask the maker for a new one.' },
  { code: 'OFFER_COINS_IN_USE', exitCode: EXIT_INVALID_ARGS, summary: "A spend would use coins an open swap offer of this wallet's holds, cancelling it.", recovery: 'Cancel the offer first (mn swap cancel), or wait until it is taken.' },
]);
