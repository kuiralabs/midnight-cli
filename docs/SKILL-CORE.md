# midnight-wallet-cli — Agent Skill (Core)

You have access to the `midnight-wallet-cli` MCP server. This is the **core** skill — intent routing and non-negotiable safety rules. Fetch `midnight-wallet://skill/full` on demand for canonical multi-step flows, error-recovery recipes, concept primers (NIGHT, DUST, shielded vs unshielded), network selection, and deeper context.

**Ledger 9.** mainnet, preprod and preview run ledger 9; `midnight_localnet_up()` starts a local ledger-9 stack. Every write is proven by a proof server on the user's machine: on a hosted network the user starts one; details in `/full`.

## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
| "Create a new wallet called alice" | `midnight_wallet_generate({ name: "alice" })` |
| "Show my wallets" / "list wallets" | `midnight_wallet_list()` |
| "Switch to bob" / "use wallet bob" | `midnight_wallet_use({ name: "bob" })` |
| "What's my balance?" | `midnight_balance()` |
| "Balance for this address 0x…" | `midnight_balance({ address: "mn_addr_..." })` |
| "Send 100 NIGHT to alice" | `midnight_transfer({ to: "alice", amount: "100" })` — ask consent first |
| "Pay alice 10 and bob 5" | `midnight_transfer({ recipients: [{ to: "alice", amount: "10" }, { to: "bob", amount: "5" }] })` — one transaction; ask consent first |
| "Send shielded" | use the shielded address directly, or pass `--shielded` via the CLI |
| "Fund my wallet" (localnet only) | `midnight_airdrop({ amount: "50000" })` |
| "Register dust" / "I need fees" | `midnight_dust_register()` |
| "Am I registered for dust?" | `midnight_dust_status()` |
| "Start localnet" / "start a local network" | `midnight_localnet_up()` |
| "Stop localnet" | `midnight_localnet_stop()` |
| "Show localnet logs" / "what's the indexer doing" | `midnight_localnet_logs({ tail: "200" })` |
| "Inspect this contract" / "what circuits does this dApp expose" | `midnight_contract_inspect({ path })` |
| "Deploy this contract" / "deploy on undeployed" | `midnight_contract_deploy({ path, wallet, network })` — two-step pending token, whose description gives the expected cost |
| "What would deploying this cost?" | `midnight_contract_deploy({ path, wallet, network })` — the pending token's description gives the cost; don't confirm it |
| "Call circuit X" / "submit a score" | `midnight_contract_call({ address, circuit, args })` — two-step pending token; private arguments (a bid, a vote, a coin's nonce) go in a JSON file: `args-file` |
| "What's the contract state?" / "read the ledger" | `midnight_contract_state({ address, path })` |
| "Generate tests for this contract" / "scaffold a test suite" | `midnight_test_create({ path })` (default cli; pass `strategy: "ui"` + `port` + `build-cmd` for UI tests) |
| "Does my wallet have an account?" / "show my grants" | `midnight_grant_status()` / `midnight_grant_list()` (experimental; undeployed only) |
| "Put NIGHT in my account" / "fund the account" | `midnight_grant_deposit({ amount })`, amount in NIGHT, taken from the wallet's shielded NIGHT (two-step pending token); mn can't take it back out |
| "This agent sent me a grant request link" | `midnight_grant_request({ link })` first, show the user who would spend, who they could pay and the limits (defaults apply to any not given), then `midnight_grant_issue({ link })` (two-step pending token) |
| "Revoke that agent's grant" / "revoke everything" | `midnight_grant_revoke({ grant })` / `midnight_grant_revoke_all()` (two-step pending token) |

## Safety rules (non-negotiable)

- **Read tools** (`readOnlyHint: true`) — safe to call without user consent.
- **Destructive tools** (`destructiveHint: true`) — require explicit user consent before calling.
- **Open-world tools** (`openWorldHint: true`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call `midnight_wallet_generate`.
- **Some tools use a two-step confirmation token**: `midnight_wallet_generate`, `midnight_wallet_remove`, `midnight_transfer`, `midnight_contract_deploy`, `midnight_contract_call`, `midnight_grant_deploy`, `midnight_grant_deposit`, `midnight_grant_issue`, `midnight_grant_revoke`, `midnight_grant_revoke_all`, `midnight_swap_make`, `midnight_swap_take`, `midnight_swap_cancel`. The first call returns a pending token + description and does nothing else; show the description verbatim, and call `midnight_confirm_operation({ token })` only after the user explicitly says yes. The token keeps the wallet and network the first call acted as (the active ones when it named none), and the description names them: confirming runs as them even if the active wallet or network changed since. (`midnight_wallet_generate` asks only with `force: true`, which replaces a wallet.) Full flow in `midnight-wallet://skill/full`.

## When to fetch the full skill

- On any error from a tool call → fetch `midnight-wallet://skill/full`, find the recipe in "Error recovery recipes".
- Before a multi-step flow (first session, deploying a contract, transfer with confirmation) → fetch `/full` for the canonical sequence.
- When the user asks conceptual questions (what is dust, shielded vs unshielded, which network) → fetch `/full`.
- For per-tool details: read the tool description in `tools/list`.
- For CLI reference: `mn help <command>`.
