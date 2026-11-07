// What the wallet package (wallets, balances, transfers, Dust and the cache)
// tells agents: its pieces of `help --agent` and of the two
// skills, each naming its section and its place there, and its tools' rows in
// the manual's tools table.

import { codeGuidancePieces, type PackageGuidance } from '@kuiralabs/midnight-cli-core';
import { walletCodes } from './wallet.codes.ts';

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
      body: `- Not quick to prime Dust on a hosted network the first time: a cold prime reads the chain's whole Dust event history, so it takes minutes, not seconds (mainnet's 1.6M events: about 11 minutes with the native accelerator, about 18 without).
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

  On preview, preprod and stagenet the shielded balance is not read by
  default: the first read takes a while. A wallet can still hold shielded
  tokens there (contracts mint them, others send them). midnight balance
  --force-shielded reads it, and midnight transfer --shielded needs
  --force-shielded there.

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
starts with mn_addr or mn_shield-addr (mainnet's mn_addr1 / mn_shield-addr1
included), it's used as an address directly.

`,
    },
    {
      text: 'agent-manual',
      section: 'typical-workflows',
      order: 10,
      body: `  Local development (undeployed):
  1. midnight_config_set           → Set network (key: "network", value: "undeployed")
  2. midnight_wallet_generate      → Create wallet (name: "alice")
  3. midnight_localnet_up          → Start node, indexer, proof server
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

  Mainnet (real value; never the saved network): pass network: "mainnet"
  on every call instead of setting it. Needs the user's mainnet Blockfrost
  project id (nightmainnet...). No faucet and no airdrop: the wallet is
  funded by a transfer from another wallet. Describe every write and get
  the user's consent before confirming it.

`,
    },
    {
      text: 'agent-manual',
      section: 'example-commands',
      order: 10,
      body: `  # Generate wallet (addresses on every network + seed)
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
    // Its error codes' rows in the manual and the full skill, from their definitions.
    ...codeGuidancePieces(walletCodes),
  ],
  toolsTable: [
    { tool: 'midnight_wallet_generate', group: 'wallet-management', order: 10, description: ['Create a named wallet'] },
    { tool: 'midnight_wallet_list', group: 'wallet-management', order: 20, description: ['List all wallets'] },
    { tool: 'midnight_wallet_use', group: 'wallet-management', order: 30, description: ['Set active wallet'] },
    { tool: 'midnight_wallet_info', group: 'wallet-management', order: 40, description: ['Show wallet details (incl. shielded address)'] },
    { tool: 'midnight_wallet_remove', group: 'wallet-management', order: 50, description: ['Remove a named wallet'] },
    { tool: 'midnight_info', group: 'balance-info', order: 10, description: ['Display wallet metadata'] },
    { tool: 'midnight_balance', group: 'balance-info', order: 20, description: ['Check unshielded + shielded balance'] },
    { tool: 'midnight_address', group: 'balance-info', order: 30, description: ['Derive an address from a saved wallet or a seed'] },
    { tool: 'midnight_genesis_address', group: 'balance-info', order: 40, description: ['Genesis wallet address'] },
    { tool: 'midnight_airdrop', group: 'transactions', order: 10, description: ['Fund wallet from genesis (undeployed only)'] },
    { tool: 'midnight_transfer', group: 'transactions', order: 20, description: ['Send NIGHT (two-step — returns pending token)'] },
    { tool: 'midnight_dust_register', group: 'transactions', order: 30, description: ['Register UTXOs for dust generation'] },
    { tool: 'midnight_dust_status', group: 'transactions', order: 40, description: ['Check dust balance and registration'] },
    { tool: 'midnight_cache_clear', group: 'configuration', order: 40, description: ['Clear cached wallet sync state'] },
  ],
};
