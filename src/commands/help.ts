// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right (all on stderr)
// Agent-friendly: plain text when piped (non-TTY)
// JSON mode: outputs capability manifest for agent self-discovery
// Every list of commands it shows comes from the command registry (plan 2D).

import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';
import { WORDMARK_BIG } from '../ui/art.ts';
import { installedCommands } from '../lib/installed-commands.ts';
import { commandHelpSpecs, introBriefs, type CommandHelpSpec } from '../lib/command-definition.ts';
import { hasShownIntroThisSession, markIntroShown } from '../lib/intro-marker.ts';
import { UsageError } from '../lib/errors.ts';
import type { CallContext, CallOutput } from '../lib/call-context.ts';
import { PKG_NAME, PKG_VERSION, PKG_DESCRIPTION } from '../lib/pkg.ts';
import { INDEXER_GRAPHQL_WS_PATH } from '../lib/constants.ts';

type CommandSpec = CommandHelpSpec;

/** Every command help lists, from the registry. */
function helpSpecs(): CommandSpec[] {
  return commandHelpSpecs(installedCommands);
}

// Build the right column: wordmark (lines 0-2), blank, then commands
function buildRightColumn(): string[] {
  const lines: string[] = [];
  // Lines 0-2: big wordmark (animated by animateMaterialize)
  for (const wl of WORDMARK_BIG) {
    lines.push(wl);
  }
  // Line 3: blank
  lines.push('');
  // Line 4: header
  lines.push(bold('Commands'));
  // Lines 5+: command briefs
  for (const [name, brief] of introBriefs(installedCommands)) {
    lines.push(`${teal(name.padEnd(18))}${brief}`);
  }
  // Footer
  lines.push('');
  lines.push(dim(`midnight (or mn) help <command>`));
  lines.push(dim(`--json flag available on all commands`));
  lines.push(dim(`midnight help --agent`) + dim(`  AI & MCP reference`));
  return lines;
}

// Plain text output for non-TTY / agent-friendly
function printPlainHelp(output: CallOutput): void {
  output.stderr('\nCommands:\n\n');
  for (const [name, brief] of introBriefs(installedCommands)) {
    output.stderr(`  ${name.padEnd(18)}${brief}\n`);
  }
  output.stderr('\n  Usage: midnight <command> (or: mn <command>)\n');
  output.stderr('  --json flag available on all commands\n');
  output.stderr('  midnight help --agent   AI & MCP reference\n\n');
}

function printCommandHelp(output: CallOutput, spec: CommandSpec): void {
  output.stdout('\n' + header(spec.name) + '\n\n');
  output.stdout(`  ${spec.description}\n\n`);
  output.stdout(gray('Usage:') + '\n');
  output.stdout(`  ${spec.usage}\n\n`);

  if (spec.flags && spec.flags.length > 0) {
    output.stdout(gray('Flags:') + '\n');
    for (const flag of spec.flags) {
      output.stdout(`  ${flag}\n`);
    }
    output.stdout('\n');
  }

  if (spec.examples && spec.examples.length > 0) {
    output.stdout(gray('Examples:') + '\n');
    for (const example of spec.examples) {
      output.stdout(`  ${dim('$')} ${example}\n`);
    }
    output.stdout('\n');
  }
}

function outputJsonManifest(ctx: CallContext): void {
  const manifest = {
    cli: {
      name: PKG_NAME,
      version: PKG_VERSION,
      description: PKG_DESCRIPTION,
      bin: ['midnight', 'mn'],
    },
    globalFlags: installedCommands.globalFlagsHelp.map(flag => ({ name: flag.name, description: flag.description })),
    commands: helpSpecs().map(spec => ({
      name: spec.name,
      description: spec.description,
      usage: spec.usage,
      flags: spec.flags,
      examples: spec.examples,
      jsonFields: spec.jsonFields,
    })),
  };

  ctx.output.result(manifest);
}

function printAgentManual(output: CallOutput): void {
  const manual = `
MIDNIGHT CLI — AI Agent & MCP Reference
========================================

Version: ${PKG_VERSION}

OVERVIEW
────────

midnight-wallet-cli (mn) is a standalone CLI wallet for the Midnight
blockchain. It manages wallets, balances, transfers (unshielded and
shielded), dust fees, a DApp connector server, contract inspection,
E2E testing, and a local devnet — all from the terminal.

Wallets are network-agnostic: one seed derives addresses for all three
networks (undeployed, preprod, preview). Network is chosen at runtime.

Preprod's indexer and node are served by Blockfrost (Midnight shut its own
preprod indexer down on 2026-10-09). Every request needs the user's own
project id, from a Midnight preprod project at https://blockfrost.io:
  midnight config set blockfrost-project-id <project id>
or MN_BLOCKFROST_PROJECT_ID (or BLOCKFROST_PROJECT_ID) in the environment.
Without one, a command that
reaches preprod fails with BLOCKFROST_PROJECT_ID_REQUIRED. The project id is
a secret: mn never prints it. Preview and undeployed need none.

LEDGER 9 ONLY: this build of mn speaks ledger 9 only. A chain still on
ledger 8 (preview and preprod today) is refused up front with an
error saying so; use midnight-wallet-cli 0.5.x for those. localnet up
is refused too (no published ledger-9 indexer image yet): run a ledger-9
stack yourself and point mn at it with --node / --indexer-ws /
--proof-server, or once with midnight config set node|indexer-ws|proof-server.

STRUCTURED JSON OUTPUT
──────────────────────

Every command supports --json. When passed:
  - stdout receives a single line of JSON
  - stderr is fully suppressed (no spinners, no formatting)
  - Errors: {"error":true,"code":"...","message":"...","exitCode":N}

Usage: midnight <command> [args] --json

CAPABILITY MANIFEST
───────────────────

  midnight help --json

Outputs a machine-readable manifest with all commands, flags,
examples, and JSON field schemas.

COMMANDS & JSON SCHEMAS
───────────────────────
${helpSpecs().filter(s => s.jsonFields).map(spec => {
  const fields = Object.entries(spec.jsonFields!)
    .map(([k, v]) => `    ${k.padEnd(20)}${v}`)
    .join('\n');
  return `
  ${spec.name}
  ${spec.usage}
  JSON fields:
${fields}`;
}).join('\n')}

SHIELDED TRANSACTIONS
─────────────────────

Midnight supports private (shielded) transactions using zero-knowledge
proofs. The CLI provides full shielded support:

  Balance (shows both unshielded + shielded):
    midnight balance --json
    → { address, shieldedAddress, network,
        unshielded: { NIGHT, utxoCount },
        shielded: { NIGHT, availableCoins, pendingCoins } }

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

  On preview/preprod, shielded sync is off by default (no faucet there).
  Pass --force-shielded to midnight balance or midnight transfer to force
  the shielded sync on for those networks.

Note: there is no self-shielding. Shielded coins come from receiving
transfers from wallets that already have shielded tokens.

WALLET NAME RESOLUTION
──────────────────────

Transfer commands accept wallet names instead of full addresses:

  midnight transfer alice 10           → resolves alice's unshielded address
  midnight transfer alice 10 --shielded → resolves alice's shielded address

Names are resolved from ~/.midnight/wallets/<name>.json. If the input
starts with mn_addr_ or mn_shield-addr_, it's used as an address directly.

DAPP CONNECTOR
──────────────

  midnight serve [--port 9932] [--approve-all | --approve-fees] [--network name]

Starts a WebSocket JSON-RPC server implementing the Midnight
ConnectedAPI interface (same as the Lace browser wallet). Any DApp
can connect to it — no browser extension needed.

  - Port default: 9932, localhost only
  - Read operations: never prompt
  - Write operations, balancing included (balanceUnsealedTransaction /
    balanceSealedTransaction sign and return a finished transaction):
    terminal approval prompt (or --approve-all)
  - --approve-fees: fee wallet for an agent. balanceUnsealedTransaction /
    balanceSealedTransaction pay only the Dust fee and are auto-approved when
    the transaction spends none of this wallet's funds, has no unsigned
    unshielded input, and needs no non-Dust value; otherwise they are
    refused. submitTransaction is auto-approved only for a transaction this
    server balanced that way on the same connection. Everything else still
    prompts (rejected without a terminal). --max-fee <DUST> (default 10)
    and --max-pending <n> (default 2) bound what an agent can cost it.
  - A fee the wallet's Dust doesn't cover yet (its NIGHT is still generating
    it): serve waits when the rest is at most 2 minutes away, and otherwise
    refuses at once with DUST_REQUIRED and the time ("generates the rest in
    about 4 minutes"): retry then. mn's own commands (contract, test run,
    grant) wait up to 5 minutes.
  - --json: the listening line reports the approval policy, e.g.
    "approval":{"reads":"auto","balancing":"fee-only","writes":"fee-only","feeLimits":
    {"maxFeeSpecks":"10000000000000000","maxPending":2}}
  - --no-auto-approve-reads: no effect, kept for old scripts
  - getTxHistory lists the transactions this server has seen since it
    started (submitted through it or synced after start); it is kept in
    memory, so a restart starts it empty

DApp developers connect via the midnight-wallet-connector npm package:

  npm install midnight-wallet-connector

  import { createWalletClient } from 'midnight-wallet-connector';
  const wallet = await createWalletClient({
    url: 'ws://localhost:9932',
    networkId: 'undeployed',  // or 'preprod', 'preview' — lowercase per @midnightntwrk/wallet-sdk
  });
  const balances = await wallet.getUnshieldedBalances();

Reference DApp: https://github.com/nel349/midnight-starship

SMART CONTRACTS
───────────────

Run these commands from the root of a dApp project that contains a
compiled Compact contract (managed/ directory with .js and .d.ts files).
Compile with Compact 0.35 (language 0.27): mn bundles compact-runtime
0.20.0, and code compiled for another runtime is rejected at deploy/call.

  Inspect — show circuits, witnesses, types:
    midnight contract inspect [--path <dir>] [--json]
    → { name, compilerVersion, circuits: [...], witnesses: [...] }

  Deploy — deploy a contract to the network:
    midnight contract deploy [--network <name>] [--json]
    → { contractName, address, network }
    Requires: funded wallet with dust. Auto-starts mn serve if needed.

  Call — call a circuit on a deployed contract:
    midnight contract call --address <addr> --circuit <name> [--args '<json>'] [--json]
    → { contractName, circuit, address, network, status }
    Example: midnight contract call --address abc123... --circuit post --args '["Hello!"]'

  State — read ledger state of a deployed contract:
    midnight contract state --address <addr> [--network <name>] [--json]
    → { address, network, fields: { key: value }, maps: { key: { size } } }

  Full workflow example:
    cd my-dapp
    midnight contract inspect                    # see what circuits exist
    midnight contract deploy                     # deploy to localnet
    midnight contract call --address <addr> --circuit post --args '["Hello"]'
    midnight contract state --address <addr>     # read on-chain state

GRANTS (experimental)
─────────────────────

A wallet's account is a contract its owner deploys. It holds what the owner
puts in it, and a grant lets an agent spend from it within limits, on the
agent's own key. An agent asks with a grant request link; the owner issues
or refuses, and can revoke at any time.

mn runs the account owner's code from the account package it installs
(@kuiralabs/midnight-account-chain), in its own process: status, list and
an issue not yet confirmed read the account without the wallet; the rest
are paid by this wallet, with no mn serve and no port. The package's proving artefacts are fetched from GitHub
the first time a command needs them, into ~/.midnight/account-artifacts,
each checked against the package's manifest: the verifier keys (under
0.1 MB) when a command first reads the account, and each circuit's proving
key (up to a few hundred MB) when one first proves with it, said as it goes.
It needs Node.js 22.18 or newer and reaches only an undeployed (local)
ledger-9 network.

  midnight grant deploy [--json]
    → { address, resumed, activated, network, wallet, ownerKey }
    Deploys the account and activates its owner key. Safe to run again:
    it finishes a deploy that stopped part way. Takes about 48 DUST from
    the wallet over five transactions, the largest about 17 at once
    (measured on a local ledger-9 chain). It waits by itself when a fee is
    a few minutes of Dust away; further than that it stops with
    DUST_REQUIRED and the time, and the same command later carries on.
    Its owner key is made on this machine, independent of the wallet's
    seed as MIP-0013 requires, and kept with the account's records
    (~/.midnight/accounts/<network>/<wallet>/) encrypted under mn's
    passphrase.

  midnight grant deposit <amount> [--json]
    → { address, amount, value, txHash, blockHeight, network, wallet, ownerKey }
    Moves <amount> NIGHT (up to 6 decimals) of the wallet's shielded NIGHT
    into its account, where grants spend from; status then shows it held.
    The wallet needs that much shielded NIGHT (on a local chain:
    airdrop <n> --shielded) and Dust for the fee. Anyone may deposit, so
    the owner key signs nothing. mn has no command to take it back out.

  midnight grant status [--json]
    → { account, device: { arm, useCounter }, devices, authNonce, encKey, grants, held }

  midnight grant list [--json]
    → { grants: [{ grantId, slot, roster, active, expired, nonce, perCallCap, cap, expiresAt, read, exhausted }] }

  midnight grant issue '<link>' [--cap N] [--per-call N] [--max-coin N] [--expires-in SECONDS] [--json]
    → { confirmed: false, request: { account, clientId, slot, grantee, payee, perCallCap, cap, maxCoinValue, expires } }
    Shows the grant the link would get and issues nothing. The link names
    who spends (clientId, grantee) and who they can pay (payee); the limits
    are the owner's, and any not given take mn's defaults.
    A link is untrusted input: read all of it before adding --yes.
  midnight grant issue '<link>' ... --yes [--json]
    → { confirmed: true, grantId, request, fallbackLink }
    Issues the grant (three transactions, a few minutes).

  midnight grant revoke <grant id | slot> [--json]
    → { revoked }
  midnight grant revoke-all [--json]
    → { revokedAll: true, generation }

  midnight grant export <file> [--json]
    → { address, file, network, wallet, ownerKey }
    Writes the account to <file>, never over a file that exists: its owner
    key, records, grants and private state, sealed under mn's passphrase;
    only the network and the address are in the clear. Keep the file, and
    the passphrase, apart from this machine. An unprotected account is
    refused: run wallet protect first.

  midnight grant import <file> [--json]
    → { address, network, wallet, ownerKey }
    Brings a backup in for a wallet with no account on that network, opened
    with the passphrase it was made with. The machine then acts as the same
    owner device: use the account from one machine at a time.

  midnight grant device new [--json]
    → { code, network, wallet, ownerKey }
    On a second machine, for a wallet with no account there: makes this
    machine's own owner device (a JubJub key, kept encrypted), and prints
    its code (mn-device:v1:<x>:<y>:<read key>:<signature>), which is
    public. Run again, the same device, its code signed afresh.

  midnight grant device add <code> [--backup <file>] [--json]
    → { action, code, backup?, ... }
    On a machine that owns the account: adds the device with that code,
    then seals the account to it on chain, in the account's inbox: its
    secret, the read keys of the account's devices, and every live grant.
    An owner app that reads the chain joins from that alone. With --backup,
    also writes <file>, a backup for another mn: everything but this
    machine's owner key; on the new machine, midnight grant import <file>
    makes it an owner on its own.

  midnight grant device remove <code> [--json]
    → { action, code, removed, ... }
    Removes the device with that code (a lost machine's), from another
    device on the account. The account's encryption key is rotated after,
    away from it, and re-sealed to every live grant. Never this machine's
    device, never the last. A device already removed only owes the
    rotation, which is done.

  midnight grant device list [--json]
    → { devices: [{ code, thisMachine }] }

Amounts are whole numbers of the token's smallest unit, as text in JSON.

E2E TESTING
───────────

  midnight test run [--suite <name>] [--json]
  midnight test list [--json]
  midnight test results [--all] [--json]

Runs E2E tests for Midnight dApps defined in dapp.test.json. Includes
contract deployment, circuit calls, and state verification.

ERROR CODES
───────────

  Code                    Exit  Meaning
  INVALID_ARGS            2     Missing or invalid arguments
  WALLET_NOT_FOUND        3     Wallet file does not exist
  NETWORK_ERROR           4     Connection refused, timeout, DNS failure
  SYNC_TIMEOUT            4     Wallet sync exceeded its deadline (retry resumes)
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
  CHAIN_CLOCK_BEHIND      4     The chain's clock lags this computer's (a local
                                chain after sleep); wait for it or restart it
  UNSUPPORTED_LEDGER      4     The chain is on ledger 8; use mn 0.5.x for it
  LOCALNET_UNAVAILABLE    4     localnet up can't start a ledger-9 stack; run
                                one and set its endpoints (config set)
  LOCAL_STACK_UNREACHABLE 4     No ledger-9 stack answers at the endpoints
  AMBIGUOUS_LOCAL_STACKS  4     Several local stacks run; pass endpoint flags
  UNSUPPORTED_NODE        1     Node.js is older than 22 (22.18 for mn grant);
                                install a current one
  NO_ACCOUNT              1     mn grant: the wallet has no account on this
                                network; run grant deploy
  WRONG_PASSPHRASE        2     mn's passphrase was wrong, or a sealed secret
                                was changed
  PASSPHRASE_REQUIRED     2     A secret was needed and no passphrase could be
                                had: set MN_PASSPHRASE, or run at a terminal
  BLOCKFROST_PROJECT_ID_REQUIRED 4
                                Preprod is served by Blockfrost and no project
                                id is set: config set blockfrost-project-id
  BLOCKFROST_PROJECT_ID_REJECTED 4
                                Blockfrost refused the project id (HTTP 403)
  BLOCKFROST_LIMIT_REACHED 4    Blockfrost's plan or rate limit; wait and retry
  ENDPOINT_SHUT_DOWN      4     An endpoint set by flag or config was shut down
                                by its operator; unset it
  CANCELLED               7     Operation cancelled (SIGINT)
  UNKNOWN                 1     Unclassified error

MCP SERVER
──────────

The CLI includes an MCP (Model Context Protocol) server for native
AI agent integration. Agents call typed tools directly via JSON-RPC
over stdio — no shell spawning or output parsing.

Setup:

  Claude Code (.mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  CLI: claude mcp add --transport stdio midnight-wallet -- midnight-wallet-mcp

  Cursor (.cursor/mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  VS Code (.vscode/mcp.json):
  { "servers": { "midnight-wallet": { "type": "stdio", "command": "midnight-wallet-mcp" } } }

If not installed globally, use "command": "npx" with
"args": ["-y", "midnight-wallet-cli@latest", "--mcp"].

AVAILABLE MCP TOOLS (30)
────────────────────────

  Wallet Management
  midnight_wallet_generate     Create a named wallet                                name
  midnight_wallet_list         List all wallets                                     —
  midnight_wallet_use          Set active wallet                                    name
  midnight_wallet_info         Show wallet details (incl. shielded address)         —
  midnight_wallet_remove       Remove a named wallet                                name

  Balance & Info
  midnight_info                Display wallet metadata                              —
  midnight_balance             Check unshielded + shielded balance                  —
  midnight_address             Derive address from seed                             seed
  midnight_genesis_address     Genesis wallet address                               —
  midnight_inspect_cost        Display block cost limits                            —

  Transactions
  midnight_airdrop             Fund wallet from genesis (undeployed only)           amount
  midnight_transfer            Send NIGHT (two-step — returns pending token)        to, amount
  midnight_dust_register       Register UTXOs for dust generation                   —
  midnight_dust_status         Check dust balance and registration                  —

  Consent
  midnight_confirm_operation   Redeem a pending token returned by a destructive     token
                               tool (step 2 of the confirmation flow)

  Configuration
  midnight_config_get          Read a config value                                  key
  midnight_config_set          Write a config value                                 key, value
  midnight_config_unset        Reset a config value to default                      key
  midnight_cache_clear         Clear cached wallet sync state                       —

  Local Network
  midnight_localnet_up         Refused on this ledger-9 build (see OVERVIEW)        —
  midnight_localnet_stop       Stop local network (preserves state)                 —
  midnight_localnet_down       Full teardown (volumes + undeployed cache)           —
  midnight_localnet_status     Show service status and ports                        —
  midnight_localnet_clean      Remove conflicting containers                        —
  midnight_localnet_logs       Snapshot of recent logs from each service            —

  Contracts (Compact smart contracts)
  midnight_contract_inspect    Read circuits, witnesses, ledger shape from         path / managed / name
                               compiled artifact (no chain access needed)
  midnight_contract_state      Query a deployed contract's ledger state            address, path
  midnight_contract_deploy     Deploy a compiled contract (two-step pending token) path / managed
  midnight_contract_call       Call a circuit on a deployed contract               address, circuit
                               (two-step pending token; args auto-coerce numbers
                               and "123n" strings to BigInt, [0–255] to Uint8Array)

  Test Framework
  midnight_test_create         Generate a CLI or browser test scaffold from the    path, strategy,
                               compiled contract                                   port, build-cmd

Optional params shared by wallet tools: wallet, network.
All tools return JSON. Every response carries _serverVersion so a stale
MCP server (CLI on disk says X, responses still say Y) is detectable.
Errors: {error, code, message, _serverVersion}.

TOOL ANNOTATIONS (MCP safety hints)
───────────────────────────────────

Every tool carries MCP-spec annotations so clients can apply safety policy
without hardcoding per-tool rules:

  readOnlyHint      Safe to call without user consent (balance, info, list).
  destructiveHint   Moves funds, deletes files, or tears down infra — treat
                    as requiring user consent.
  idempotentHint    Repeated calls with same args yield the same result.
  openWorldHint     Touches the network / chain / Docker — can fail
                    non-deterministically.

TWO-STEP CONFIRMATION FLOW (midnight_transfer)
──────────────────────────────────────────────

midnight_transfer does NOT execute on the first call. It returns a pending
token that the agent must show to the user for consent, then redeem via
midnight_confirm_operation to actually execute.

  Call 1:  midnight_transfer({ to, amount, wallet, network })
           → { pending: true, token, description, expiresAt, nextStep }
  Show:    the description to the user verbatim.
  Call 2:  midnight_confirm_operation({ token })
           → actual transfer result (txHash, etc)

Tokens are single-use and expire after 5 minutes.

MCP RESOURCES (skill files)
───────────────────────────

The server exposes two MCP Resources — a small core and a fuller guide:

  uri       midnight-wallet://skill/core
  name      midnight-wallet skill (core)
  mimeType  text/markdown
  Read this first. Intent routing table + non-negotiable safety rules
  (~830 tokens). Fetch on session start.

  uri       midnight-wallet://skill/full
  name      midnight-wallet skill (full)
  mimeType  text/markdown
  Canonical multi-step flows, error-recovery recipes, concept primers
  (NIGHT/DUST/shielded), network selection. Fetch on demand — on an error,
  a multi-step flow, or a concept question.

The bare midnight-wallet://skill URI stays as a deprecated alias for
skill/full so existing clients keep working; it is not advertised in
resources/list. Ground responses in these instead of training-data guesses.

TYPICAL AGENT WORKFLOWS
───────────────────────

  Local development (undeployed, against a ledger-9 stack you run):
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
  1. midnight_airdrop              → Fund shielded (amount: "100", shielded: "true")
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

  Contract development (CLI only — not an MCP tool):
  Run "mn dev" in a Compact project. It checks the local network is up,
  provisions 3 funded wallets (dev-alice/dev-bob/dev-carol), compiles on
  save, and accepts a "d" keystroke to deploy the current artifact with
  dev-alice. See "mn help dev". On this ledger-9 build it uses a ledger-9
  stack you run (configured endpoints) instead of starting one.

EXAMPLE CLI COMMANDS
────────────────────

  # Generate wallet (all 3 network addresses + seed)
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

  # Contract inspection
  midnight contract inspect --json
  # → {"name":"bboard","compilerVersion":"0.35.0","circuits":[{"name":"post",...}],"witnesses":[...]}

  # Deploy contract (from dApp root directory)
  midnight contract deploy --json
  # → {"subcommand":"deploy","contractName":"bboard","address":"6cc5...","network":"undeployed"}

  # Call a circuit
  midnight contract call --address 6cc5... --circuit post --args '["Hello from CLI!"]' --json
  # → {"subcommand":"call","circuit":"post","status":"success"}

  # Read contract state
  midnight contract state --address 6cc5... --json
  # → {"subcommand":"state","fields":{"state":"1","message":"...","owner":"..."}}

  # Start DApp connector (fee-wallet mode for an agent's own transactions)
  midnight serve --approve-fees
  # DApps connect at ws://localhost:9932
`;

  output.stdout(manual);
}

export default async function helpCommand(args: ParsedArgs, ctx: CallContext): Promise<void> {
  // Agent manual: comprehensive reference for AI agents
  if (hasFlag(args, 'agent')) {
    printAgentManual(ctx.output);
    return;
  }

  // JSON mode: output capability manifest
  if (hasFlag(args, 'json')) {
    outputJsonManifest(ctx);
    return;
  }

  // Specific command help: wallet help <command>
  const targetCommand = args.subcommand;

  if (targetCommand) {
    const specs = helpSpecs();
    const spec = specs.find(s => s.name === targetCommand);
    if (!spec) {
      throw new UsageError(
        `Unknown command: "${targetCommand}"\n` +
        `Available commands: ${specs.map(s => s.name).join(', ')}`
      );
    }
    printCommandHelp(ctx.output, spec);
    return;
  }

  // General help: horizontal layout (logo + commands side by side)
  if (!process.stderr.isTTY) {
    // Agent-friendly: plain text, no animation, no ANSI
    printPlainHelp(ctx.output);
    return;
  }
  const rightColumn = buildRightColumn();

  // Cinematic logo materialize plays only on the first invocation in this
  // shell session. Follow-up calls render the same layout statically so
  // viewers who just want the help text are not made to wait.
  // Override with `--intro` to force the animation, `--no-intro` to skip it.
  const forceIntro = hasFlag(args, 'intro');
  const skipIntro = hasFlag(args, 'no-intro');
  const seen = hasShownIntroThisSession();
  const animated = forceIntro || (!skipIntro && !seen);

  await animateMaterialize(undefined, rightColumn, { animated });
  if (animated) markIntroShown();
}

export { helpSpecs };
export type { CommandSpec };
