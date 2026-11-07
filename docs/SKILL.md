# midnight-wallet-cli — Agent Skill

You have access to the `midnight-wallet-cli` MCP server. This document teaches you how to use it well. Read it once at the start of a session; use it as reference throughout.

> **Ledger 9 only.** This build speaks ledger 9 only. A chain still on ledger 8 is refused up front with an error saying so: tell the user to use `midnight-wallet-cli` 0.5.x for it, don't retry. `midnight_localnet_up()` starts a ledger-9 stack for `undeployed` on the default ports (node 9944, indexer 8088, proof server 6300); another stack is reached by setting its URLs with `midnight_config_set` (keys `node`, `indexer-ws`, `proof-server`) or passing `--node` / `--indexer-ws` / `--proof-server` on the CLI.

## What you can do with this CLI

Act on the user's behalf on Midnight, through what the installed packages bring:

- Manage wallets, check balances, transfer NIGHT (unshielded or shielded) and register Dust, the fee token.
- Deploy, call, inspect and read Compact smart contracts, and read the chain's block limits.
- Serve a wallet to a dApp over the DApp connector, including as a fee wallet for an agent's transactions (`mn serve --approve-fees`).
- Scaffold and run a dApp's end-to-end tests, and manage a local Midnight network.
- Swap one shielded token for another privately with another wallet, through an offer file: make it, inspect it, take it at the agreed terms.
- Deploy the wallet's account, fund it, and issue and revoke the grants that let an agent spend from it.

Most commands are MCP tools (`tools/list` shows each, and what it takes). These have none, and the user runs them in their own terminal: `mn generate`, `mn serve`, `mn dev`, `mn help`, `mn manual`; some subcommands have none either.

## Core concepts (teach these accurately)

- **Midnight** — a privacy-first blockchain. Supports both **unshielded** (transparent, like Bitcoin) and **shielded** (ZK-private, like Zcash) transactions in one chain.
- **NIGHT** — the native token. 1 NIGHT = 1,000,000 micro-NIGHT (6 decimals).
- **DUST** — a second token used to pay transaction fees. Not transferable. **Generated passively** by registered NIGHT UTXOs. Every wallet holding NIGHT must register those UTXOs for dust generation before it can send anything. Don't explain dust as "gas" — it's time-phase regenerative, not a fee market.
- **Shielded vs unshielded** — shielded addresses start `mn_shield-addr_*`; unshielded start `mn_addr_*` (on mainnet, with no network segment: `mn_shield-addr1…`, `mn_addr1…`). A wallet has one of each per network. Sender controls the privacy: `mn transfer --shielded` sends privately.
- **No self-shielding** — a wallet cannot move its own funds from unshielded to shielded. To get shielded NIGHT, receive a shielded transfer from a wallet that already has some (genesis wallet has 250M shielded NIGHT on localnet).
- **Networks**
  - `undeployed` — local network (`midnight_localnet_up()` starts it). Use this for dev iteration.
  - `preprod` — public testnet (refused by this build while it is on ledger 8). Its indexer and node are served by Blockfrost and need the user's own project id (see "Preprod and mainnet need a Blockfrost project id" below). First-time wallet sync processes the full event history and can take significantly longer than subsequent syncs (which restore from cached wallet state). Exact time depends on wallet age, event density, network, and hardware. Its shielded balance is not read by default (the first read takes a while), though a wallet can hold shielded tokens there (contracts mint them): pass `force-shielded` to `midnight_balance`, and to `midnight_transfer` with `shielded`.
  - `preview` — public preview testnet (ledger 9). Same first-sync trade-off and shielded default as preprod.
  - `stagenet` — Sig Network's testnet, on the beta SDK set (mn loads its beta engine for it). No shielded faucet; as on preview and preprod, the shielded balance is not read by default (the first read takes a while), and `force-shielded` reads it; NIGHT from https://faucet.stagenet.shielded.tools. Its proof server must match its node (`midnightntwrk/proof-server:9.0.0-rc.5_experimental`). Grant is refused there for now.
  - `mainnet` — Midnight Mainnet: real value. Reached only through Blockfrost with the user's mainnet project id (it starts with `nightmainnet`); the proof server is the user's local one. No faucet. Used only when named on each call (`network: "mainnet"`, or `--network mainnet`): it can't be the saved network, and a call without a network never reaches it. `midnight_airdrop`, the test tools and the grant tools are refused there with `MAINNET_REFUSED`.
- **Proof server** — local HTTP service that generates ZK proofs for transactions. Default port 6300. Version must match the network's ledger version or writes fail with "Custom error 170".

### mn's secrets are encrypted under one passphrase

Every secret mn keeps (each wallet's seed and mnemonic, each account's owner key, records and private state) is encrypted at rest under the user's one passphrase. A tool that needs one (a transfer, a grant command, anything that signs or reads a seed) reads the passphrase from `MN_PASSPHRASE` in the MCP server's environment; without it, it fails with `PASSPHRASE_REQUIRED` and changes nothing. It is a secret: never ask for it in chat or echo it. Wallets an earlier mn wrote in plain text still work, with a warning, until the user runs `midnight wallet protect` in their own terminal, which encrypts every wallet and account in one step. Adding a second owner device to an account (`midnight grant device new | add | remove | list`) and writing or bringing in an account's encrypted backup (`midnight grant export | import`) are command-line only: suggest them when the user wants to keep their account if this machine is lost.

### Preprod and mainnet need a Blockfrost project id

Midnight shut its own preprod and mainnet indexers down on 2026-10-09. Blockfrost serves their indexers and nodes now, and every request needs the user's own project id (created at https://blockfrost.io, one project per network; preprod ids start with `nightpreprod`, mainnet ids with `nightmainnet`; each is kept for its own network and never sent to the other; requests count against the user's Blockfrost plan). The user sets it once with `midnight config set blockfrost-project-id <project id>` in their own terminal, or `BLOCKFROST_PROJECT_ID` (or `MN_BLOCKFROST_PROJECT_ID`) in the MCP server's environment. It is a secret: `midnight_config_get` shows it masked, no tool result contains it, and you should never ask for it in chat or echo it. Preview and the local network need none.

## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
| "Create a new wallet called alice" | `midnight_wallet_generate({ name: "alice" })` |
| "Show my wallets" / "list wallets" | `midnight_wallet_list()` |
| "Switch to bob" / "use wallet bob" | `midnight_wallet_use({ name: "bob" })` |
| "What's my balance?" | `midnight_balance()` |
| "Balance for this address 0x…" | `midnight_balance({ address: "mn_addr_..." })` |
| "Send 100 NIGHT to alice" | `midnight_transfer({ to: "alice", amount: "100" })` — ask consent first |
| "Send shielded" | add `--shielded` (the CLI command) or use shielded address directly |
| "Fund my wallet" (localnet only) | `midnight_airdrop({ amount: "1000" })` |
| "Fund this address …" (localnet only) | `midnight_airdrop({ amount: "1000", wallet: "mn_addr_undeployed1…" })` — `wallet` accepts a name, path, or raw bech32m address |
| "Register dust" / "I need fees" | `midnight_dust_register()` |
| "Am I registered for dust?" | `midnight_dust_status()` |
| "Start localnet" / "start a local network" | `midnight_localnet_up()` |
| "Stop localnet" | `midnight_localnet_stop()` |

## Canonical flows

### New user, first session (localnet)
1. Make sure a ledger-9 stack is running and reachable (see the note at the top); `midnight_localnet_up()` won't start one on this build.
2. `midnight_wallet_generate({ name: "alice" })` — create wallet, set active.
3. `midnight_airdrop({ amount: "1000" })` — fund from genesis.
4. `midnight_dust_register()` — make wallet able to pay fees.
5. `midnight_balance()` — confirm funds visible.

At step 5 the user is ready to transact.

### User wants to send tokens (safely — two-step confirmation flow)

`midnight_transfer` does **not** execute on the first call. It returns a pending token that you must redeem via `midnight_confirm_operation` after the user confirms.

1. Call `midnight_transfer({ to, amount })` — returns `{ pending: true, token, description, expiresAt }`.
2. Show `description` (e.g. "Send 100 NIGHT from alice to mn_addr_preprod1… on preprod") to the user verbatim. Do not paraphrase amounts or recipients.
3. Wait for the user's explicit consent.
4. If yes: call `midnight_confirm_operation({ token })` — this actually executes the transfer and returns the result (tx hash, etc).
5. If no: do nothing; the token expires in 5 minutes.
6. On success: surface the tx hash. On failure: read the error and suggest recovery (see below).

**Never skip step 2–3.** The whole point of the token flow is that the user sees the exact operation before funds move.

### User wants to deploy a contract
Use `midnight_contract_*` MCP tools (or `mn contract` CLI). Flow: `compact compile` in the project → `midnight_contract_inspect({ path })` to verify artifacts → `midnight_contract_deploy({ path, wallet, network })` → returns address → `midnight_contract_call({ address, circuit, args, ... })` to exercise it. State reads via `midnight_contract_state({ address, ... })`.

**Project layouts handled.** The scan looks for `managed/<name>/compiler/contract-info.json` under: project root, `contract/`, `contract/src/`, `contracts/`, `contracts/src/`, `src/`. If none match, pass `managed: "<full path to managed/<name>/>"` directly.

**Multi-contract projects.** Inspect returns a `siblings: string[]` field listing other contracts under the same `managed/`. Pick one with `name: "<contract>"` on inspect/deploy/call/state.

**Arg encoding for circuits.** The MCP `args` param is a JSON string. The bridge auto-coerces, recursing into objects and arrays:
- `number` (integer, within `Number.MAX_SAFE_INTEGER`) → `BigInt`
- `"123n"` (BigInt-literal syntax) → `BigInt(123)` — required for values beyond safe-integer range, e.g. 256-bit field elements in elliptic-curve points like `{x: "3577…n", y: "5455…n"}`
- array of `[0–255]` ints → `Uint8Array` (any Compact `Bytes<N>` arg, e.g. `[1,2,3,…,32]`)
- objects: each value coerced under the same rules → `Struct` args
- arrays (non-byte): each element coerced

Plain strings, booleans, fractional numbers, and `null` pass through unchanged. No hex-string detection — `"1234"` stays a string.

**Compatibility caveat — runtime version skew.** Contracts must be compiled with Compact 0.36 (language 0.28). The CLI bundles `@midnight-ntwrk/compact-runtime` `0.21.0`, so contracts have to target runtime `0.21.0`. Artifacts built for another runtime (e.g. `0.16.0`, from a ledger-8 toolchain) are rejected at deploy/call with a message like `CompactError: Version mismatch: compiled code expects 0.16.0`. The fix is to recompile with Compact 0.36 (`compact compile`) rather than asking the user to change `mn`; a contract that must stay on the ledger-8 toolchain belongs with `midnight-wallet-cli` 0.5.x. `midnight_contract_inspect` shows the compiled `runtimeVersion` so you can flag the mismatch before attempting deploy.

**Stale MCP server.** Every MCP response carries `_serverVersion`. If the user upgraded `midnight-wallet-cli` but `_serverVersion` lags `mn --version`, the MCP client is talking to a long-lived stale process. Tell them to disconnect and re-add the MCP server (a /mcp reconnect alone will not respawn it).

### Agent needs a fee wallet for its own dApp transactions

When an agent builds and proves its own ledger-9 transaction (its own value already balanced) and only needs the Dust fee paid, the user runs `mn serve --approve-fees` (CLI only, not an MCP tool). In that mode `balanceUnsealedTransaction` / `balanceSealedTransaction` add only Dust, and are auto-approved only when the transaction spends none of the wallet's funds, has no unsigned unshielded input, needs no non-Dust value, and is not a rewards claim; otherwise they are refused with every reason listed. `submitTransaction` is auto-approved only for a transaction that server balanced that way on the same connection. Everything else still prompts the user (and is rejected without a terminal). `--approve-fees` cannot be combined with `--approve-all`. Two limits bound what an agent can cost the wallet: `--max-fee <DUST>` refuses a transaction whose total Dust fee (the agent's transaction plus the wallet's balancing) is higher (default 10 DUST; a simple contract call costs about 0.5), and `--max-pending <n>` refuses new balances while n balanced transactions wait to be submitted (default 2). Both are checked before any Dust is reserved. Each balanced transaction reserves a whole Dust coin until it is submitted and on chain (about 20 seconds on a 6-second-block localnet) or released, so a fee wallet serves as many agents at once as it has Dust coins: one per NIGHT UTXO registered for Dust generation. A request that finds none free waits for one, then fails with an error saying so. With `--json`, the line `mn serve` prints once it is listening includes the approval policy (`"approval": {"reads": "auto", "balancing": "fee-only", "writes": "fee-only", "feeLimits": {"maxFeeSpecks": "10000000000000000", "maxPending": 2}}`), so whoever started it can check what it will approve.

### User wants to give an agent an allowance (experimental)

A wallet's account is a contract its owner deploys. A grant lets an agent spend from it within limits, on the agent's own key; the owner can revoke it at any time. The `midnight_grant_*` tools (CLI: `mn grant`) run the account owner's code from the account package mn installs (`@kuiralabs/midnight-account-chain`) in mn's own process. `midnight_grant_status`, `midnight_grant_list` and `midnight_grant_request` read the account without the wallet; the others are paid by the wallet, with no `mn serve` and no port. They are experimental: names, parameters and results can change.

What has to be true first: Node.js is 22.18 or newer, and the network is `undeployed` (a local ledger-9 stack) or `stagenet` (where a grant request that pins its calling contract is refused with `CALLER_PIN_UNSUPPORTED`). The first grant tool also needs to reach github.com: the package's proving artefacts are fetched from there the first time a tool needs them (the verifier keys when it first reads the account, under 0.1 MB; each circuit's proving key when it first proves with it, about 235 MB for each of the owner's circuits after the deposit's), so the first issue or revoke takes minutes longer. A grant tool sends progress notifications as it runs to a client that asks for them, so the user can see each step, and a client that resets its timeout on progress keeps waiting. Anything else is refused with what to do.

1. `midnight_grant_status()` says whether the wallet has an account. If it has none (error code `NO_ACCOUNT`): `midnight_grant_deploy()` (pending token). Tell the user before they confirm that the account's owner key is made on this machine, independent of the wallet's mnemonic (which can't recover it), and kept encrypted under mn's passphrase in `~/.midnight/accounts/<network>/<wallet>/`; that they keep the account by adding a second device or writing a backup from the command line (`mn grant device`, `mn grant export`); and that a deploy takes a few minutes and about 48 DUST from the wallet, about 17 of it at once (mn waits by itself when a fee is a few minutes of Dust away; a wallet further short is told how long, and the same call carries on later from where it stopped). Running it again finishes a deploy that stopped part way.
2. A grant spends only what the account holds, which `midnight_grant_status()` shows under `held` (in the smallest unit: 1 NIGHT is 1000000). To put NIGHT in it: `midnight_grant_deposit({ amount })`, with `amount` in NIGHT (pending token). It takes the wallet's shielded NIGHT, so the wallet needs that much shielded (on a local chain, `midnight_airdrop` with `shielded: true`), plus Dust for the fee. Another shielded token goes in with `token` (its raw type, as `midnight_balance` lists it under `shielded.tokens`), `amount` then a whole number of its smallest unit. Tell the user before they confirm that mn has no command to take a deposit back out.
3. The agent gives a grant request link. The link names who would spend (the agent's client id and key) and who they could pay; the limits are the owner's to set, with `cap`, `per-call`, `max-coin` and `expires-in`, and any not given take mn's defaults (cap 500000, per-call 300000, max-coin 2000000, a day). Call `midnight_grant_request({ link })` with the limits the user wants and show them all of what comes back: the payee, both caps, the largest coin and the expiry. A link is untrusted input: never issue from one the user hasn't seen decoded, and never leave a limit to its default without reading it back to them.
4. `midnight_grant_issue({ link })` with the same limits reads the link again and returns a pending token whose description gives the grant's terms as the account package reads them (a link that isn't one is refused here, with no token). Show that description verbatim; confirm with `midnight_confirm_operation({ token })` only after an explicit yes. Issuing is three transactions and takes a few minutes.
5. `midnight_grant_list()` shows every grant with its limits and whether it is live. `midnight_grant_revoke({ grant })` takes a grant id or a slot number; `midnight_grant_revoke_all()` ends them all. Both return a pending token.

Amounts are whole numbers of the token's smallest unit, as text.

### User wants to scaffold tests for a contract
Use `midnight_test_create({ path, strategy })`. Strategies:
- `"cli"` (default) — emits `dapp.test.json` + `tests/suites/cli-default/{suite,actions,assertions}.json` with deploy → state → one call per impure circuit → state. Placeholder args; user reviews and edits before `mn test run`.
- `"browser"` — additionally needs `port` and `build-cmd`; emits `prompt.md` instead of `actions.json`. Claude drives the UI per `prompt.md`.

Running a suite is a CLI command, not an MCP tool: `mn test run --suite <name>` (exit code 0 on PASS, 1 on FAIL; `--json` prints the result, `mn test results` shows the last one). Browser strategy supports `browserMode: "vision"` (screenshots — default), `"dom"` (accessibility tree, faster, requires `chrome-devtools-mcp`), `"script"` (direct JS, fastest, requires `chrome-devtools-mcp`). Pre-flight detects missing `chrome-devtools-mcp` and orphan automation Chromes from prior crashes.

## Safety rules (non-negotiable)

- **Read tools** (`readOnlyHint: true`) — safe to call without user consent.
- **Destructive tools** (`destructiveHint: true`) — require explicit user consent before calling.
- **Open-world tools** (`openWorldHint: true`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call `midnight_wallet_generate`.
- **Some tools use a two-step confirmation token**: `midnight_wallet_generate`, `midnight_wallet_remove`, `midnight_transfer`, `midnight_contract_deploy`, `midnight_contract_call`, `midnight_grant_deploy`, `midnight_grant_deposit`, `midnight_grant_issue`, `midnight_grant_revoke`, `midnight_grant_revoke_all`, `midnight_swap_make`, `midnight_swap_take`, `midnight_swap_cancel`. The first call returns a pending token + description and does nothing else; show the description verbatim, and call `midnight_confirm_operation({ token })` only after the user explicitly says yes. (`midnight_wallet_generate` asks only with `force: true`, which replaces a wallet.)

## Error recovery recipes

Every MCP tool error returns `{ error: true, code: <ERROR_CODE>, message: <human prose> }`. **Index on the `code`** — the message is human-targeted and may change. Stable codes:

| Code | Meaning | Recovery |
|---|---|---|
| `INVALID_ARGS` | Missing/invalid argument. | Show the message to the user verbatim — it names the missing field. |
| `WALLET_NOT_FOUND` | Named wallet doesn't exist on disk. | `midnight_wallet_list()` — user may have removed it. |
| `NETWORK_ERROR` | Indexer/node/proof-server connection refused or DNS failure. | Check `midnight_localnet_status()` (start it with `midnight_localnet_up()`) or the endpoints the user configured. |
| `SYNC_TIMEOUT` | Long-running wallet sync hit its deadline. Common on a hosted-network first-cold-sync. | Retry; the cache resumes from the last applied event so progress is preserved. |
| `INSUFFICIENT_BALANCE` | Wallet doesn't have enough NIGHT to cover the requested amount. | Show the user. On localnet: `midnight_airdrop({ amount: "..." })`. On hosted networks: tell user to fund the address. |
| `TX_REJECTED` | Chain rejected the submitted transaction (catch-all when no more specific code applies). | Read the message; usually a state mismatch resolved by re-sync + retry. |
| `STALE_UTXO` | UTXO was already spent on-chain (substrate "error code 115"). | Re-sync (the next call will refresh state) and retry. |
| `STALE_CACHE` | Local wallet cache disagrees with chain (e.g. localnet reset, remote testnet re-indexed). | `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `PROOF_TIMEOUT` | ZK proof generation didn't finish within the deadline. | Retry — proofs can be slow under load. |
| `PROOF_FAILURE` | Proof server rejected or failed to generate the ZK proof. Often a stale commitment tree or unreachable proof server. | Check that the proof server is running (`midnight_localnet_status()`, or the endpoint the user configured); if it is, `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `INVALID_DUST_PROOF` | Chain rejected the dust spend proof as malformed (substrate "Custom error 170"). Stale commitment tree. | `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `DUST_REQUIRED` | Wallet has NIGHT but not enough DUST for the fee. | Not registered (`midnight_dust_status()` shows `registered: false`): run `midnight_dust_register()`. Registered: its NIGHT is still generating the fee, which happens with time. mn has already waited when the fee was a few minutes away; the message says how long the rest takes ("generates the rest in about 4 minutes"). Wait that long and retry, don't retry at once. |
| `DUST_GENERATING` | A Dust registration can't pay its fee yet: the wallet's NIGHT hasn't generated enough Dust. | The message says when: run `midnight_dust_register()` again then, or add NIGHT. |
| `CHAIN_CLOCK_BEHIND` | The chain's clock lags this computer's (a local chain after sleep), so Dust estimates don't hold. | Wait for it to catch up, or ask the user to restart the local chain. |
| `UNSUPPORTED_LEDGER` | The network is on ledger 8; this build supports ledger 9 only. | Tell the user: this network needs midnight-wallet-cli 0.5.x. Don't retry. |
| `NO_TEST_CONFIG` | No dapp.test.json in the folder the test command ran in. | Ask the user to run it from the dApp's root, or create one with `mn test create`. |
| `LOCAL_STACK_UNREACHABLE` | No ledger-9 stack answers at the configured endpoints. | Ask the user to start their stack or fix the configured node / indexer-ws / proof-server endpoints. |
| `AMBIGUOUS_LOCAL_STACKS` | Several local Midnight stacks are running and no endpoints are configured, so mn won't guess. | Ask the user which stack to use; they set its endpoints with `midnight config set`. Don't retry blindly. |
| `UNSUPPORTED_NODE` | Node.js is older than 22 (22.18 for mn grant). | Ask the user to install a current Node.js. |
| `NO_NODE_RUNTIME` | Contract scripts run under Node.js, and none was found on PATH. | Ask the user to install Node.js 22 or later, or to run mn under Node. |
| `CONTRACT_NOT_COMPILED` | No compiled contract was found where the command looked (managed/<name>/compiler/contract-info.json). | Ask the user to compile the contract (compact compile), or pass the dApp folder (path) or the managed folder (managed). |
| `CONTRACT_INFO_INVALID` | A compiled contract's contract-info.json is not what the Compact compiler writes (not JSON, or its circuits or witnesses missing or malformed). | The message names what is wrong: ask the user to compile the contract again (compact compile). |
| `NO_ACCOUNT` | A grant command (`midnight_grant_*` tool) was called for a wallet that has no account on this network. | Offer `midnight_grant_deploy()`, after telling the user how its owner key is kept (see the allowance flow). |
| `CALLER_PIN_UNSUPPORTED` | A grant request pins the contract that calls the account, and the account on this network (stagenet) has no caller pin; nothing was submitted. | Tell the user; ask the agent for a grant request that names no calling contract, or issue it on undeployed. |
| `WRONG_PASSPHRASE` | `MN_PASSPHRASE` is not the passphrase mn's secrets were encrypted with, or a sealed file was changed. | Ask the user to correct `MN_PASSPHRASE` in the MCP server's environment. Nothing was changed. |
| `PASSPHRASE_REQUIRED` | A tool needed a secret (a wallet's seed, an account's owner key) and no passphrase could be had: `MN_PASSPHRASE` is unset and there is no terminal to ask at (the MCP server has none). | Ask the user to set `MN_PASSPHRASE` in the MCP server's environment and restart it. Never ask them to type the passphrase into the chat. |
| `BLOCKFROST_PROJECT_ID_REQUIRED` | The network (preprod or mainnet) is served by Blockfrost and no project id is set for it. | Ask the user to create a Blockfrost project for that Midnight network at https://blockfrost.io (a preprod id starts with `nightpreprod`, a mainnet id with `nightmainnet`) and run `midnight config set blockfrost-project-id <project id>` themselves. Never ask them to paste the id into the chat. Don't retry until they have. |
| `BLOCKFROST_PROJECT_ID_REJECTED` | Blockfrost refused the project id (HTTP 403): mistyped, revoked, or for another network. | Ask the user to check it at blockfrost.io and set it again. Don't retry blindly. |
| `BLOCKFROST_LIMIT_REACHED` | Blockfrost's plan limit or rate limit. | Wait and retry once; if it persists, tell the user it is their Blockfrost plan. |
| `ENDPOINT_SHUT_DOWN` | An endpoint set by flag or config was shut down by its operator (the old preprod indexer, mainnet's old Midnight-hosted indexer and node). | `midnight_config_unset({ key: "indexer-ws" })` (and `node` if set), then retry. |
| `MAINNET_REFUSED` | The command is refused on mainnet before anything runs: an airdrop (mainnet has no faucet), a test suite (it deploys throwaway contracts), or mn grant (no released account build there). | Tell the user why (the message says) and don't retry on mainnet; offer undeployed or a test network instead. |
| `OTHER_SDK_SET` | The process runs one SDK set's engine and the network runs on the other (an MCP server that served rc asked for stagenet). | Make the call in a process of its own: ask the user to start an MCP server for that network. |
| `MIXED_SDK_LAYOUT` | mn's packages were installed without each engine's shrinkwrap (bun's installer): an engine's SDK tree isn't the one it was tested with. | Ask the user to install mn with npm. |
| `NO_STATE_ROOT` | The host gave mn no place to keep its state (a program's `createHost` without paths). | Give the host its paths (`createHost({ paths })`). |
| `NO_PAYER` | A command that submits a transaction was called without a payer. | Give the call a payer. |
| `SERVE_PORT_IN_USE` | The port mn serve was to use is taken by a process that can't serve this command (another program, or an mn serve for another network, chain or wallet). | The message names the port and how to find the process on it: ask the user to stop that process, or run on another port. |
| `APPROVAL_UNAVAILABLE` | A request to mn serve needed approval and nobody could be asked: the serve has no terminal and was not started to approve it without asking. | Ask the user to restart mn serve with --approve-all (or --approve-fees for a wallet that only pays an agent's Dust fee), or to run it at a terminal. |
| `COMMAND_FAILED` | A command ended with a non-zero exit code without throwing (an MCP test run whose tests failed); the message carries its result. | Read the command's result in the message. |
| `NOT_AN_OFFER` | The bytes given as a swap offer are not one. | Ask the maker for the offer again. |
| `TERMS_MISMATCH` | A swap offer's own terms differ from the agreed ones. | Don't take it; agree the terms again with the maker. |
| `OFFER_EXPIRED` | A swap offer is past the expiry its maker set. | Ask the maker for a new one. |
| `OFFER_COINS_IN_USE` | A spend would use coins an open swap offer of this wallet's holds, cancelling it. | Cancel the offer first (`mn swap cancel`), or wait until it is taken. |
| `CANCELLED` | Operation was aborted (SIGINT, or the MCP call was cancelled). | A transaction already submitted may still have landed: read the state first (`midnight_grant_status`, `midnight_balance`). Don't retry without confirming with the user. |
| `UNKNOWN` | Error didn't match any known classifier. | Surface the message to the user. If reproducible, a new code may be warranted. |

A tool's description ends with the codes it can fail with: its own, and sets of them by name. The sets:

| Set | Codes |
|---|---|
| network | `AMBIGUOUS_LOCAL_STACKS`, `BLOCKFROST_PROJECT_ID_REQUIRED`, `BLOCKFROST_PROJECT_ID_REJECTED`, `BLOCKFROST_LIMIT_REACHED`, `ENDPOINT_SHUT_DOWN` |
| wallet | `WALLET_NOT_FOUND`, `WRONG_PASSPHRASE`, `PASSPHRASE_REQUIRED` |
| engine | `OTHER_SDK_SET`, `MIXED_SDK_LAYOUT` |
| sync | `NETWORK_ERROR`, `SYNC_TIMEOUT`, `STALE_CACHE` |
| paying | `TX_REJECTED`, `STALE_UTXO`, `INVALID_DUST_PROOF`, `PROOF_TIMEOUT`, `PROOF_FAILURE`, `DUST_REQUIRED`, `DUST_GENERATING`, `INSUFFICIENT_BALANCE`, `OFFER_COINS_IN_USE` |
| offers | `NOT_AN_OFFER`, `TERMS_MISMATCH` |
| chain | `UNSUPPORTED_LEDGER`, `LOCAL_STACK_UNREACHABLE` |
| contract | `CONTRACT_NOT_COMPILED`, `CONTRACT_INFO_INVALID`, `NO_NODE_RUNTIME` |

## When to use which network

- **Developing a contract?** → `undeployed` (a ledger-9 stack the user runs locally). No first-sync cost; everything is local.
- **Integration testing against a hosted chain?** → `preprod`, once it runs ledger 9 (refused while it is on ledger 8). First sync for a new wallet on this network processes full event history; subsequent syncs restore from cache and are much faster.
- **Demoing to users?** → `preview` (if the dApp is deployed there) or `undeployed` (if self-contained).
- **Mainnet?** → `mainnet`, named on every call (`network: "mainnet"`); it is never the default. Needs the user's mainnet Blockfrost project id. Moves real value: describe amount, recipient and network and get the user's go-ahead before any write. No faucet; no airdrop, test suites or grants there.

## What this CLI is NOT

- Not a custody service. Keys are on the user's disk (`~/.midnight/wallets/<name>.json`).
- Not an instant-sync tool for a first-time wallet on a hosted network. First run replays the chain's event history; the CLI caches state after that so repeat runs are fast.
- Not a contract compiler. The project's `package.json` should expose a `compact` script (Midnight convention, e.g. `"compact": "compact compile src/foo.compact src/managed/foo"`) or a `compile` script as a generic fallback. `mn dev` detects whichever is present; create-mn-app and midnight-starship templates ship with the `compact` script already wired.
- Not quick to prime Dust on a hosted network the first time: a cold prime reads the chain's whole Dust event history, so it takes minutes, not seconds (mainnet's 1.6M events: about 11 minutes with the native accelerator, about 18 without).

## Authoritative references

- `mn help <command>` — per-command usage and flags.
- `mn help --agent` — structured reference manual for AI clients.
- `mn help --json` — every command's usage, flags and JSON fields, as JSON.
