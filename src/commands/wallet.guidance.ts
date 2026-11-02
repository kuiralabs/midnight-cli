// What the wallet package (wallets, balances, transfers, Dust and the cache)
// tells agents: its pieces of `help --agent` and of the two
// skills, each naming its section and its place there, and its tools' rows in
// the manual's tools table.

import type { PackageGuidance } from '@kuiralabs/midnight-cli-core/lib/agent-guidance';

export const walletGuidance: PackageGuidance = {
  pieces: [
    {
      text: 'skill-full',
      section: 'what-you-can-do',
      order: 10,
      body: `- Manage wallets, check balances, transfer NIGHT (unshielded or shielded) and register Dust, the fee token.
`,
    },
    {
      text: 'skill-full',
      section: 'not-this-cli',
      order: 20,
      body: `- Not quick to prime Dust on a hosted network, on this ledger-9 build: priming always runs in WASM (the native accelerator is built for ledger 8 and is not used), so a cold prime takes minutes, not seconds.
`,
    },
    {
      text: 'agent-manual',
      section: 'shielded-transactions',
      order: 10,
      body: `SHIELDED TRANSACTIONS
─────────────────────

Midnight supports private (shielded) transactions using zero-knowledge
proofs. The CLI provides full shielded support:

  Balance (shows both unshielded + shielded):
    midnight balance --json
    → { address, shieldedAddress, network,
        unshielded: { NIGHT, utxoCount },
        shielded: { NIGHT, availableCoins, pendingCoins,
                    tokens: { <raw token type>: amount } } }

  Shielded airdrop (localnet only — genesis has 250M shielded NIGHT):
    midnight airdrop 100 --shielded --json
    → { txHash, amount, shieldedAddress, network, type: "shielded" }

  Shielded transfer (to shielded address or wallet name):
    midnight transfer alice 50 --shielded --json
    midnight transfer mn_shield-addr_... 50 --shielded --json
    → { txHash, amount, recipient, network, type: "shielded" }

  Positional address balance (unshielded only, fast GraphQL):
    midnight balance mn_addr_... --json
    → { address, network, balances, utxoCount, txCount }

  Shielded balance is private — it can't be read from an address alone
  (no secret key). Pass --shielded with a positional address and, if the
  address is one of your wallets, it maps to that wallet's full sync;
  otherwise it errors and points you to --wallet <name> --shielded.

  On preview, preprod and stagenet, shielded sync is off by default (no faucet there).
  Pass --force-shielded to midnight balance or midnight transfer to force
  the shielded sync on for those networks.

Note: there is no self-shielding. Shielded coins come from receiving
transfers from wallets that already have shielded tokens.

`,
    },
    {
      text: 'agent-manual',
      section: 'wallet-name-resolution',
      order: 10,
      body: `WALLET NAME RESOLUTION
──────────────────────

Transfer commands accept wallet names instead of full addresses:

  midnight transfer alice 10           → resolves alice's unshielded address
  midnight transfer alice 10 --shielded → resolves alice's shielded address

Names are resolved from ~/.midnight/wallets/<name>.json. If the input
starts with mn_addr_ or mn_shield-addr_, it's used as an address directly.

`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 20,
      body: `  WALLET_NOT_FOUND        3     Wallet file does not exist
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 40,
      body: `  SYNC_TIMEOUT            4     Wallet sync exceeded its deadline (retry resumes)
  INSUFFICIENT_BALANCE    5     Not enough NIGHT for the operation
  TX_REJECTED             6     Transaction rejected by the node
  STALE_UTXO              6     UTXOs consumed by another transaction
  STALE_CACHE             6     Local cache disagrees with chain state
  PROOF_TIMEOUT           6     ZK proof generation timed out
  PROOF_FAILURE           6     Proof server failed to generate the ZK proof
  INVALID_DUST_PROOF      6     Chain rejected the dust spend proof as malformed
  DUST_REQUIRED           5     Not enough Dust for the fee. Not registered:
                                dust register. Generating: the message says
                                how long (retry then, or register more NIGHT)
  DUST_GENERATING         5     Dust registration fee not generated yet; the
                                message says when (rerun then, or add NIGHT)
`,
    },
    {
      text: 'agent-manual',
      section: 'error-codes',
      order: 120,
      body: `  PASSPHRASE_REQUIRED     2     A secret was needed and no passphrase could be
                                had: set MN_PASSPHRASE, or run at a terminal
`,
    },
    {
      text: 'agent-manual',
      section: 'typical-workflows',
      order: 10,
      body: `  Local development (undeployed, against a ledger-9 stack you run):
  1. midnight_config_set           → Set network (key: "network", value: "undeployed")
     midnight_config_set           → node / indexer-ws / proof-server URLs of that stack
  2. midnight_wallet_generate      → Create wallet (name: "alice")
  3. (midnight_localnet_up is refused on this build; see OVERVIEW)
  4. midnight_airdrop              → Fund wallet (amount: "1000")
  5. midnight_dust_register        → Register for fee tokens
  6. midnight_balance              → Check unshielded + shielded balance
  7. midnight_transfer             → Returns pending token + description
  8. (show description to user, get explicit consent)
  9. midnight_confirm_operation    → Redeem token → actual transfer runs
 10. midnight_dust_status          → Check remaining dust

  Shielded workflow:
  1. midnight_airdrop              → Fund shielded (amount: "100", shielded: true)
  2. midnight_balance              → Shows both unshielded + shielded
  3. midnight_transfer             → Returns pending token for shielded send
  4. (show + consent) → midnight_confirm_operation

  Testnet (preprod/preview, once the network runs ledger 9; refused
  while it is still on ledger 8):
  1. midnight_wallet_generate      → Create wallet
  2. midnight_config_set           → Set network (key: "network", value: "preview")
  3. (fund via faucet: https://faucet.preview.midnight.network/)
  4. midnight_dust_register        → Register for fees
  5. midnight_balance              → Check balance
  6. midnight_transfer → midnight_confirm_operation → transfer

  Stagenet (Sig Network's testnet, on the beta SDK set): the same steps
  with value "stagenet", funded at https://faucet.stagenet.shielded.tools/.

`,
    },
    {
      text: 'agent-manual',
      section: 'example-commands',
      order: 10,
      body: `  # Generate wallet (all 3 network addresses + seed)
  midnight wallet generate alice --json
  # → {"name":"alice","addresses":{...},"activeAddress":"mn_addr_...","activeNetwork":"undeployed","seed":"...","file":"..."}

  # Balance (full sync — unshielded + shielded)
  midnight balance --json
  # → {"address":"mn_addr_...","shieldedAddress":"mn_shield-addr_...","network":"undeployed","unshielded":{"NIGHT":"1000.000000","utxoCount":1},"shielded":{"NIGHT":"10.000000","availableCoins":1,"pendingCoins":0}}

  # Transfer by wallet name
  midnight transfer bob 100 --json
  # → {"txHash":"00ab...","amount":100,"recipient":"mn_addr_...","network":"undeployed"}

  # Shielded transfer
  midnight transfer bob 50 --shielded --json
  # → {"txHash":"00cd...","amount":50,"recipient":"mn_shield-addr_...","network":"undeployed","type":"shielded"}

  # Shielded airdrop (localnet only)
  midnight airdrop 100 --shielded --json
  # → {"txHash":"00ef...","amount":100,"shieldedAddress":"mn_shield-addr_...","network":"undeployed","type":"shielded"}

`,
    },
    {
      text: 'skill-core',
      section: 'intent-routing',
      order: 10,
      body: `| "Create a new wallet called alice" | \`midnight_wallet_generate({ name: "alice" })\` |
| "Show my wallets" / "list wallets" | \`midnight_wallet_list()\` |
| "Switch to bob" / "use wallet bob" | \`midnight_wallet_use({ name: "bob" })\` |
| "What's my balance?" | \`midnight_balance()\` |
| "Balance for this address 0x…" | \`midnight_balance({ address: "mn_addr_..." })\` |
| "Send 100 NIGHT to alice" | \`midnight_transfer({ to: "alice", amount: "100" })\` — ask consent first |
| "Send shielded" | use the shielded address directly, or pass \`--shielded\` via the CLI |
| "Fund my wallet" (localnet only) | \`midnight_airdrop({ amount: "1000" })\` |
| "Register dust" / "I need fees" | \`midnight_dust_register()\` |
| "Am I registered for dust?" | \`midnight_dust_status()\` |
`,
    },
    {
      text: 'skill-full',
      section: 'intent-routing',
      order: 10,
      body: `| "Create a new wallet called alice" | \`midnight_wallet_generate({ name: "alice" })\` |
| "Show my wallets" / "list wallets" | \`midnight_wallet_list()\` |
| "Switch to bob" / "use wallet bob" | \`midnight_wallet_use({ name: "bob" })\` |
| "What's my balance?" | \`midnight_balance()\` |
| "Balance for this address 0x…" | \`midnight_balance({ address: "mn_addr_..." })\` |
| "Send 100 NIGHT to alice" | \`midnight_transfer({ to: "alice", amount: "100" })\` — ask consent first |
| "Send shielded" | add \`--shielded\` (the CLI command) or use shielded address directly |
| "Fund my wallet" (localnet only) | \`midnight_airdrop({ amount: "1000" })\` |
| "Fund this address …" (localnet only) | \`midnight_airdrop({ amount: "1000", wallet: "mn_addr_undeployed1…" })\` — \`wallet\` accepts a name, path, or raw bech32m address |
| "Register dust" / "I need fees" | \`midnight_dust_register()\` |
| "Am I registered for dust?" | \`midnight_dust_status()\` |
`,
    },
    {
      text: 'skill-full',
      section: 'canonical-flows',
      order: 10,
      body: `### New user, first session (localnet)
1. Make sure a ledger-9 stack is running and reachable (see the note at the top); \`midnight_localnet_up()\` won't start one on this build.
2. \`midnight_wallet_generate({ name: "alice" })\` — create wallet, set active.
3. \`midnight_airdrop({ amount: "1000" })\` — fund from genesis.
4. \`midnight_dust_register()\` — make wallet able to pay fees.
5. \`midnight_balance()\` — confirm funds visible.

At step 5 the user is ready to transact.

### User wants to send tokens (safely — two-step confirmation flow)

\`midnight_transfer\` does **not** execute on the first call. It returns a pending token that you must redeem via \`midnight_confirm_operation\` after the user confirms.

1. Call \`midnight_transfer({ to, amount })\` — returns \`{ pending: true, token, description, expiresAt }\`.
2. Show \`description\` (e.g. "Send 100 NIGHT from alice to mn_addr_preprod1… on preprod") to the user verbatim. Do not paraphrase amounts or recipients.
3. Wait for the user's explicit consent.
4. If yes: call \`midnight_confirm_operation({ token })\` — this actually executes the transfer and returns the result (tx hash, etc).
5. If no: do nothing; the token expires in 5 minutes.
6. On success: surface the tx hash. On failure: read the error and suggest recovery (see below).

**Never skip step 2–3.** The whole point of the token flow is that the user sees the exact operation before funds move.

`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 10,
      body: `| \`INSUFFICIENT_BALANCE\` | Wallet doesn't have enough NIGHT to cover the requested amount. | Show the user. On localnet: \`midnight_airdrop({ amount: "..." })\`. On hosted networks: tell user to fund the address. |
| \`DUST_REQUIRED\` | Wallet has NIGHT but not enough DUST for the fee. | Not registered (\`midnight_dust_status()\` shows \`registered: false\`): run \`midnight_dust_register()\`. Registered: its NIGHT is still generating the fee, which happens with time. mn has already waited when the fee was a few minutes away; the message says how long the rest takes ("generates the rest in about 4 minutes"). Wait that long and retry, don't retry at once. |
| \`INVALID_DUST_PROOF\` | Chain rejected the dust spend proof as malformed (substrate "Custom error 170"). Stale commitment tree. | \`midnight_cache_clear({ wallet: "<name>" })\` then retry. |
| \`STALE_CACHE\` | Local wallet cache disagrees with chain (e.g. localnet reset, remote testnet re-indexed). | \`midnight_cache_clear({ wallet: "<name>" })\` then retry. |
| \`STALE_UTXO\` | UTXO was already spent on-chain (substrate "error code 115"). | Re-sync (the next call will refresh state) and retry. |
| \`PROOF_FAILURE\` | Proof server rejected or failed to generate the ZK proof. Often a stale commitment tree or unreachable proof server. | Check that the proof server is running (\`midnight_localnet_status()\`, or the endpoint the user configured); if it is, \`midnight_cache_clear({ wallet: "<name>" })\` then retry. |
| \`PROOF_TIMEOUT\` | ZK proof generation didn't finish within the deadline. | Retry — proofs can be slow under load. |
| \`SYNC_TIMEOUT\` | Long-running wallet sync hit its deadline. Common on a hosted-network first-cold-sync. | Retry; the cache resumes from the last applied event so progress is preserved. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 80,
      body: `| \`PASSPHRASE_REQUIRED\` | A tool needed a secret (a wallet's seed, an account's owner key) and the MCP server has no passphrase. | Ask the user to set \`MN_PASSPHRASE\` in the MCP server's environment and restart it. Never ask them to type the passphrase into the chat. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 100,
      body: `| \`WALLET_NOT_FOUND\` | Named wallet doesn't exist on disk. | \`midnight_wallet_list()\` — user may have removed it. |
`,
    },
    {
      text: 'skill-full',
      section: 'error-recovery',
      order: 120,
      body: `| \`TX_REJECTED\` | Chain rejected the submitted transaction (catch-all when no more specific code applies). | Read the message; usually a state mismatch resolved by re-sync + retry. |
`,
    },
  ],
  toolsTable: [
    { tool: 'midnight_wallet_generate', group: 'wallet-management', order: 10, description: ['Create a named wallet'] },
    { tool: 'midnight_wallet_list', group: 'wallet-management', order: 20, description: ['List all wallets'] },
    { tool: 'midnight_wallet_use', group: 'wallet-management', order: 30, description: ['Set active wallet'] },
    { tool: 'midnight_wallet_info', group: 'wallet-management', order: 40, description: ['Show wallet details (incl. shielded address)'] },
    { tool: 'midnight_wallet_remove', group: 'wallet-management', order: 50, description: ['Remove a named wallet'] },
    { tool: 'midnight_info', group: 'balance-info', order: 10, description: ['Display wallet metadata'] },
    { tool: 'midnight_balance', group: 'balance-info', order: 20, description: ['Check unshielded + shielded balance'] },
    { tool: 'midnight_address', group: 'balance-info', order: 30, description: ['Derive address from seed'] },
    { tool: 'midnight_genesis_address', group: 'balance-info', order: 40, description: ['Genesis wallet address'] },
    { tool: 'midnight_airdrop', group: 'transactions', order: 10, description: ['Fund wallet from genesis (undeployed only)'] },
    { tool: 'midnight_transfer', group: 'transactions', order: 20, description: ['Send NIGHT (two-step — returns pending token)'] },
    { tool: 'midnight_dust_register', group: 'transactions', order: 30, description: ['Register UTXOs for dust generation'] },
    { tool: 'midnight_dust_status', group: 'transactions', order: 40, description: ['Check dust balance and registration'] },
    { tool: 'midnight_cache_clear', group: 'configuration', order: 40, description: ['Clear cached wallet sync state'] },
  ],
};
